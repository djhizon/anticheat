import AppKit
import Foundation
import Darwin
import CoreGraphics
import IOKit
import AVFoundation
import CoreMediaIO

struct Identity: Codable, Equatable {
    let pid: Int32
    let bundleId: String
    let bundlePath: String
    let executablePath: String
    let launchDate: Double
}
struct Entry: Codable {
    let identity: Identity
    let name: String
    let protected: Bool
    let exempt: Bool
    let reason: String
}
struct Request: Decodable {
    let action: String
    let hostPid: Int32
    let hostExecutable: String
    let target: Identity?
    let demo: Bool?
    let level: Double?
    /// True only for unpackaged development builds; packaged builds omit it (false).
    let development: Bool?
}
struct Reply: Encodable {
    var apps: [Entry]? = nil
    var exemptions: [String]? = nil
    var status: String? = nil
    var error: String? = nil
    // Built-in display brightness (brightness-get / brightness-set); 0...1.
    var supported: Bool? = nil
    var brightness: Double? = nil
    var method: String? = nil
    // Video capture devices (camera-list); read-only enumeration, no stream is opened.
    var cameras: [CameraEntry]? = nil
}
enum Failure: Error { case unavailable }

// Development exemptions apply in demo mode only; strict mode never honours them.
// Every AI assistant / IDE belongs here (never in the baseline), so Strict can close it.
let temporaryExemptionNames: [(id: String, name: String)] = [
    ("com.apple.Terminal", "Terminal"), ("com.openai.chat", "ChatGPT"),
    ("com.openai.codex", "Codex"), ("com.google.antigravity", "Antigravity")
]
let temporaryExemptions: Set<String> = Set(temporaryExemptionNames.map { $0.id })
// System UI only; exempt in every mode.
let baselineExemptions: Set<String> = [
    "com.apple.finder", "com.apple.dock", "com.apple.systemuiserver",
    "com.apple.controlcenter", "com.apple.loginwindow"
]
// Strict (demo == false) honours no development exemption at all.
func isTemporaryExempt(_ bundleId: String, demo: Bool) -> Bool {
    return demo && temporaryExemptions.contains(bundleId)
}
let protectedIds = baselineExemptions.union([
    "com.googlecode.iterm2", "com.examguard.desktop"
])

func identity(_ app: NSRunningApplication) -> Identity? {
    // Direct Terminal launches may have no LaunchServices launchDate. Use the
    // kernel start timestamp so those apps still have an instance-bound identity.
    var processInfo = proc_bsdinfo()
    let size = Int32(MemoryLayout<proc_bsdinfo>.size)
    guard proc_pidinfo(app.processIdentifier, PROC_PIDTBSDINFO, 0, &processInfo, size) == size else { return nil }
    let started = Double(processInfo.pbi_start_tvsec) + Double(processInfo.pbi_start_tvusec) / 1_000_000
    guard let bundle = app.bundleIdentifier, !bundle.isEmpty,
          let url = app.bundleURL, let executable = app.executableURL,
          started > 0, !app.isTerminated else { return nil }
    return Identity(pid: app.processIdentifier, bundleId: bundle,
                    bundlePath: url.resolvingSymlinksInPath().path,
                    executablePath: executable.resolvingSymlinksInPath().path,
                    launchDate: started)
}

// Fixed executable paths and argv only; never shell commands or guessed PIDs.
func command(_ executable: String, _ args: [String], allowNoMatches: Bool = false) throws -> String {
    let task = Process()
    task.executableURL = URL(fileURLWithPath: executable)
    task.arguments = args
    let pipe = Pipe()
    task.standardOutput = pipe
    task.standardError = FileHandle.nullDevice
    try task.run()
    let output = pipe.fileHandleForReading.readDataToEndOfFile()
    task.waitUntilExit()
    guard task.terminationStatus == 0 || (allowNoMatches && task.terminationStatus == 1 && output.isEmpty),
          let text = String(data: output, encoding: .utf8) else { throw Failure.unavailable }
    return text
}

/// Pids that may never be offered for closing: the exam's own processes (roots and everything
/// they started) and, ONLY in development builds, the chain of ancestors (the terminal/IDE that
/// launched `npm run dev`). A packaged app's ancestors are ordinary user apps (for example an AI
/// assistant or remote-control tool that opened it) and must stay quittable; system UI such as
/// Finder/Dock/launchd is protected by bundle id, not by ancestry.
func relatedPids(parents: [Int32: Int32], roots: Set<Int32>, includeAncestors: Bool) -> Set<Int32> {
    var protected = roots
    if includeAncestors {
        for root in roots {
            var current = root
            var visited: Set<Int32> = []
            while let parent = parents[current], parent > 0, !visited.contains(parent) {
                protected.insert(parent)
                visited.insert(parent)
                current = parent
            }
        }
    }
    // Descend ONLY from designated roots, not shared ancestors like launchd.
    var descendants = roots
    var frontier = roots
    while !frontier.isEmpty {
        let next = Set(parents.filter { frontier.contains($0.value) && !descendants.contains($0.key) }.map { $0.key })
        descendants.formUnion(next)
        frontier = next
    }
    return protected.union(descendants)
}

func dependencyPids(_ hostPid: Int32, development: Bool) throws -> Set<Int32> {
    let table = try command("/bin/ps", ["-axo", "pid=,ppid="])
    var parents: [Int32: Int32] = [:]
    for line in table.split(separator: "\n") {
        let values = line.split(whereSeparator: { $0.isWhitespace })
        guard values.count == 2, let pid = Int32(values[0]), let ppid = Int32(values[1]) else { throw Failure.unavailable }
        parents[pid] = ppid
    }
    guard parents[hostPid] != nil else { throw Failure.unavailable }
    var roots: Set<Int32> = [hostPid, getpid()]
    for port in [3000, 5173] {
        let output = try command("/usr/sbin/lsof", ["-nP", "-a", "-iTCP:\(port)", "-sTCP:LISTEN", "-Fp"], allowNoMatches: true)
        let pids = output.split(separator: "\n").compactMap { line -> Int32? in
            guard line.first == "p" else { return nil }
            return Int32(line.dropFirst())
        }
        // Both local services must be identifiable before offering termination.
        guard !pids.isEmpty, pids.allSatisfy({ parents[$0] != nil }) else { throw Failure.unavailable }
        roots.formUnion(pids)
    }
    return relatedPids(parents: parents, roots: roots, includeAncestors: development)
}

func inventory(_ request: Request) throws -> [Entry] {
    guard getppid() == request.hostPid,
          let host = NSRunningApplication(processIdentifier: request.hostPid),
          let hostIdentity = identity(host),
          hostIdentity.executablePath == URL(fileURLWithPath: request.hostExecutable).resolvingSymlinksInPath().path
    else { throw Failure.unavailable }
    let dependencies = try dependencyPids(request.hostPid, development: request.development == true)
    let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular && !$0.isTerminated }
    guard !apps.isEmpty else { throw Failure.unavailable }
    return try apps.map { app in
        guard let value = identity(app), let name = app.localizedName else { throw Failure.unavailable }
        let ownBundle = value.bundlePath == hostIdentity.bundlePath || value.bundlePath.hasPrefix(hostIdentity.bundlePath + "/")
        let runtime = dependencies.contains(value.pid) || ownBundle
        let temporary = isTemporaryExempt(value.bundleId, demo: request.demo == true)
        return Entry(identity: value, name: name,
                     protected: runtime || temporary || protectedIds.contains(value.bundleId),
                     exempt: ownBundle || value.pid == request.hostPid || temporary || baselineExemptions.contains(value.bundleId),
                     reason: temporary ? "Development exemption (demo mode only)"
                       : runtime ? "Protected exam runtime or local server dependency"
                       : protectedIds.contains(value.bundleId) ? "Protected application — close manually if appropriate" : "")
    }
}

// MARK: - Built-in display brightness
// DisplayServices and CoreDisplay are private frameworks, loaded lazily with dlopen so a missing
// symbol (other macOS version, Intel vs Apple Silicon) is "unsupported", never a crash. Only the
// built-in panel is ever touched; external displays are not.
func clampLevel(_ value: Double) -> Double? {
    guard value.isFinite else { return nil }
    return min(1.0, max(0.0, value))
}

func builtInDisplayID() -> CGDirectDisplayID? {
    var count: UInt32 = 0
    var ids = [CGDirectDisplayID](repeating: 0, count: 16)
    guard CGGetOnlineDisplayList(16, &ids, &count) == .success else { return nil }
    return ids.prefix(Int(count)).first { CGDisplayIsBuiltin($0) != 0 }
}

struct BrightnessBackend {
    let name: String
    let get: () -> Double?
    let set: (Double) -> Bool
}

func displayServicesBackend(_ display: CGDirectDisplayID) -> BrightnessBackend? {
    typealias GetFn = @convention(c) (UInt32, UnsafeMutablePointer<Float>) -> Int32
    typealias SetFn = @convention(c) (UInt32, Float) -> Int32
    guard let handle = dlopen("/System/Library/PrivateFrameworks/DisplayServices.framework/DisplayServices", RTLD_LAZY),
          let getSym = dlsym(handle, "DisplayServicesGetBrightness"),
          let setSym = dlsym(handle, "DisplayServicesSetBrightness") else { return nil }
    let getFn = unsafeBitCast(getSym, to: GetFn.self)
    let setFn = unsafeBitCast(setSym, to: SetFn.self)
    return BrightnessBackend(name: "DisplayServices",
        get: { var value: Float = 0; return getFn(display, &value) == 0 ? Double(value) : nil },
        set: { setFn(display, Float($0)) == 0 })
}

func coreDisplayBackend(_ display: CGDirectDisplayID) -> BrightnessBackend? {
    typealias GetFn = @convention(c) (UInt32) -> Double
    typealias SetFn = @convention(c) (UInt32, Double) -> Void
    guard let handle = dlopen("/System/Library/Frameworks/CoreDisplay.framework/CoreDisplay", RTLD_LAZY),
          let getSym = dlsym(handle, "CoreDisplay_Display_GetUserBrightness"),
          let setSym = dlsym(handle, "CoreDisplay_Display_SetUserBrightness") else { return nil }
    let getFn = unsafeBitCast(getSym, to: GetFn.self)
    let setFn = unsafeBitCast(setSym, to: SetFn.self)
    return BrightnessBackend(name: "CoreDisplay",
        get: { let value = getFn(display); return value.isFinite && value >= 0 && value <= 1 ? value : nil },
        set: { setFn(display, $0); return true })
}

func ioKitBackend() -> BrightnessBackend? {
    func forEachConnection(_ body: (io_object_t) -> Bool) -> Bool {
        var iterator: io_iterator_t = 0
        guard IOServiceGetMatchingServices(kIOMainPortDefault, IOServiceMatching("IODisplayConnect"), &iterator) == KERN_SUCCESS else { return false }
        defer { IOObjectRelease(iterator) }
        var any = false
        while case let service = IOIteratorNext(iterator), service != 0 {
            if body(service) { any = true }
            IOObjectRelease(service)
        }
        return any
    }
    let key = "brightness" as CFString
    var probe: Float = 0
    var found = false
    _ = forEachConnection { service in
        if IODisplayGetFloatParameter(service, 0, key, &probe) == kIOReturnSuccess { found = true }
        return found
    }
    guard found else { return nil }
    return BrightnessBackend(name: "IOKit",
        get: {
            var value: Float = -1
            _ = forEachConnection { IODisplayGetFloatParameter($0, 0, key, &value) == kIOReturnSuccess }
            return value >= 0 ? Double(value) : nil
        },
        set: { level in
            forEachConnection { IODisplaySetFloatParameter($0, 0, key, Float(level)) == kIOReturnSuccess }
        })
}

/// The first backend that can read the built-in display, or nil (external display only, closed lid,
/// or an OS/hardware combination without a brightness API).
func brightnessBackend() -> BrightnessBackend? {
    if let display = builtInDisplayID() {
        for backend in [displayServicesBackend(display), coreDisplayBackend(display)] {
            if let backend = backend, backend.get() != nil { return backend }
        }
    }
    if let backend = ioKitBackend(), backend.get() != nil { return backend }
    return nil
}

func brightnessReply(_ request: Request) -> Reply {
    guard let backend = brightnessBackend(), let current = backend.get() else {
        return Reply(supported: false)
    }
    if request.action == "brightness-get" {
        return Reply(supported: true, brightness: current, method: backend.name)
    }
    guard let wanted = request.level.flatMap(clampLevel), backend.set(wanted) else {
        return Reply(supported: true, brightness: current, method: backend.name)
    }
    usleep(60_000)
    return Reply(supported: true, brightness: backend.get() ?? wanted, method: backend.name)
}

// MARK: - Camera hardware attestation (camera-list)
// Read-only: AVCaptureDevice discovery plus CoreMediaIO properties. No capture session or stream is
// ever opened, so no camera (TCC) permission is needed; enumeration works while access is
// "not determined". The browser only sees labels; this lets the Mac app tell a real sensor from a
// Camera Extension / DAL plug-in (OBS, Camo, ...) that copies a harmless-looking name.
struct CameraEntry: Codable {
    let name: String
    let uniqueID: String
    let modelID: String
    let manufacturer: String
    let deviceType: String
    /// CoreMediaIO transport type as a four-character code ("bltn", "usb", "virt", ...) or "unknown".
    let transportType: String
    let isConnected: Bool
    /// Bundle id of the CoreMediaIO plug-in / Camera Extension that provides the device, if found.
    let plugInBundleId: String?
    let kind: String
    let reasons: [String]
}

struct CameraFacts {
    let deviceType: String
    let transport: UInt32?
    let plugInBundleId: String?
}

func fourCC(_ text: String) -> UInt32 {
    return text.utf8.prefix(4).reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
}
func fourCCText(_ value: UInt32) -> String {
    let bytes = [24, 16, 8, 0].map { UInt8((value >> UInt32($0)) & 0xff) }
    guard value != 0, bytes.allSatisfy({ $0 >= 0x20 && $0 < 0x7f }),
          let text = String(bytes: bytes, encoding: .ascii) else { return "unknown" }
    return text.trimmingCharacters(in: .whitespaces)
}

let transportBuiltIn = fourCC("bltn")
let transportVirtual = fourCC("virt")
/// Physical buses a real external camera can be attached through.
let physicalTransports: [UInt32: String] = [
    fourCC("usb "): "USB", fourCC("thun"): "Thunderbolt", fourCC("pci "): "PCI", fourCC("fire"): "FireWire"
]
let continuityPlugIn = "com.apple.cmio.ContinuityCaptureAgent"
let builtInDeviceType = "AVCaptureDeviceTypeBuiltInWideAngleCamera"
let continuityDeviceTypes: Set<String> = ["AVCaptureDeviceTypeContinuityCamera", "AVCaptureDeviceTypeDeskViewCamera"]

/// Pure classifier (fixtures in --self-test): builtin | usb | continuity | virtual | unknown.
func classifyCamera(_ facts: CameraFacts) -> (kind: String, reasons: [String]) {
    let transport = facts.transport ?? 0
    let transportName = fourCCText(transport)
    let plugIn = facts.plugInBundleId
    let applePlugIn = plugIn.map { $0.hasPrefix("com.apple.") } ?? false
    if transport == transportVirtual {
        return ("virtual", ["CoreMediaIO transport type is virtual" + (plugIn.map { " (provided by \($0))" } ?? "")])
    }
    if let plugIn = plugIn, plugIn.range(of: "ScreenCapture", options: .caseInsensitive) != nil {
        return ("virtual", ["Screen-capture device (\(plugIn)), not a camera sensor"])
    }
    if let plugIn = plugIn, !applePlugIn {
        if let bus = physicalTransports[transport] ?? (transport == transportBuiltIn ? "built-in" : nil) {
            return ("unknown", ["Third-party camera driver \(plugIn) reports a \(bus) transport; standard webcams use the macOS driver"])
        }
        return ("virtual", ["Provided by third-party Camera Extension / DAL plug-in \(plugIn) (transport \(transportName))"])
    }
    if plugIn == continuityPlugIn || continuityDeviceTypes.contains(facts.deviceType) {
        return ("continuity", ["iPhone Continuity Camera (\(plugIn ?? facts.deviceType))"])
    }
    if facts.deviceType == builtInDeviceType && (transport == transportBuiltIn || physicalTransports[transport] == "USB") {
        return ("builtin", ["Built-in camera (macOS driver \(plugIn ?? "unidentified"), transport \(transportName))"])
    }
    if let bus = physicalTransports[transport] {
        guard applePlugIn else {
            return ("unknown", ["\(bus) camera whose driver plug-in could not be identified"])
        }
        return ("usb", ["External \(bus) camera on the macOS driver \(plugIn!)"])
    }
    return ("unknown", ["Unrecognised camera (type \(facts.deviceType), transport \(transportName), driver \(plugIn ?? "unidentified"))"])
}

func cmioAddress(_ selector: Int) -> CMIOObjectPropertyAddress {
    return CMIOObjectPropertyAddress(mSelector: CMIOObjectPropertySelector(selector),
                                     mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
                                     mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain))
}
func cmioUInt32(_ object: CMIOObjectID, _ selector: Int) -> UInt32? {
    var address = cmioAddress(selector)
    guard CMIOObjectHasProperty(object, &address) else { return nil }
    var value: UInt32 = 0
    var used: UInt32 = 0
    let status = CMIOObjectGetPropertyData(object, &address, 0, nil, UInt32(MemoryLayout<UInt32>.size), &used, &value)
    return status == 0 && used == UInt32(MemoryLayout<UInt32>.size) ? value : nil
}
func cmioString(_ object: CMIOObjectID, _ selector: Int) -> String? {
    var address = cmioAddress(selector)
    guard CMIOObjectHasProperty(object, &address) else { return nil }
    var value: Unmanaged<CFString>? = nil
    var used: UInt32 = 0
    let status = CMIOObjectGetPropertyData(object, &address, 0, nil,
                                           UInt32(MemoryLayout<Unmanaged<CFString>?>.size), &used, &value)
    guard status == 0, let text = value?.takeRetainedValue() else { return nil }
    return text as String
}

/// CoreMediaIO device UID -> (transport, plug-in bundle id). Empty if CMIO is unavailable.
func cmioDevices() -> [String: (transport: UInt32?, plugIn: String?)] {
    let system = CMIOObjectID(kCMIOObjectSystemObject)
    var address = cmioAddress(Int(kCMIOHardwarePropertyDevices))
    var size: UInt32 = 0
    guard CMIOObjectGetPropertyDataSize(system, &address, 0, nil, &size) == 0, size > 0, size < 65536 else { return [:] }
    var ids = [CMIOObjectID](repeating: 0, count: Int(size) / MemoryLayout<CMIOObjectID>.size)
    var used: UInt32 = 0
    guard CMIOObjectGetPropertyData(system, &address, 0, nil, size, &used, &ids) == 0 else { return [:] }
    var result: [String: (transport: UInt32?, plugIn: String?)] = [:]
    for id in ids.prefix(Int(used) / MemoryLayout<CMIOObjectID>.size) {
        guard let uid = cmioString(id, Int(kCMIODevicePropertyDeviceUID)) else { continue }
        let plugIn = cmioUInt32(id, Int(kCMIODevicePropertyPlugIn)).flatMap {
            cmioString(CMIOObjectID($0), Int(kCMIOPlugInPropertyBundleID))
        }
        result[uid] = (cmioUInt32(id, Int(kCMIODevicePropertyTransportType)), plugIn)
    }
    return result
}

func cameraInventory() -> [CameraEntry] {
    var types: [AVCaptureDevice.DeviceType] = [.builtInWideAngleCamera, .deskViewCamera]
    if #available(macOS 14.0, *) {
        types += [.external, .continuityCamera]
    } else {
        types.append(.externalUnknown)
    }
    let devices = AVCaptureDevice.DiscoverySession(deviceTypes: types, mediaType: .video, position: .unspecified).devices
    let cmio = cmioDevices()
    return devices.map { device in
        let native = cmio[device.uniqueID]
        // CMIO first; AVFoundation's own transportType is the same property and a fallback.
        let transport = native?.transport ?? (device.transportType != 0 ? UInt32(bitPattern: device.transportType) : nil)
        let facts = CameraFacts(deviceType: device.deviceType.rawValue, transport: transport, plugInBundleId: native?.plugIn)
        let verdict = classifyCamera(facts)
        return CameraEntry(name: device.localizedName, uniqueID: device.uniqueID, modelID: device.modelID,
                           manufacturer: device.manufacturer, deviceType: device.deviceType.rawValue,
                           transportType: fourCCText(transport ?? 0), isConnected: device.isConnected,
                           plugInBundleId: native?.plugIn, kind: verdict.kind, reasons: verdict.reasons)
    }
}

func run(_ request: Request) throws -> Reply {
    if request.action == "camera-list" {
        guard getppid() == request.hostPid else { throw Failure.unavailable }
        return Reply(cameras: cameraInventory())
    }
    if request.action == "brightness-get" || request.action == "brightness-set" {
        guard getppid() == request.hostPid else { throw Failure.unavailable }
        return brightnessReply(request)
    }
    guard ["list", "quit", "force", "policy"].contains(request.action) else { throw Failure.unavailable }
    // Pure policy answer (no inventory, no process access): the demo-mode exemption names for the UI.
    if request.action == "policy" {
        return Reply(exemptions: request.demo == true ? temporaryExemptionNames.map { $0.name } : [])
    }
    let apps = try inventory(request)
    if request.action == "list" { return Reply(apps: apps) }
    guard let target = request.target,
          let entry = apps.first(where: { $0.identity == target }),
          !entry.protected, !entry.exempt,
          let app = NSRunningApplication(processIdentifier: target.pid),
          identity(app) == target else { return Reply(status: "refused") }
    // Native application object, never a raw signal to a potentially reused PID.
    let accepted = request.action == "quit" ? app.terminate() : app.forceTerminate()
    return Reply(status: accepted ? "requested" : "refused")
}

if CommandLine.arguments.dropFirst().elementsEqual(["--self-test"]) {
    // Pure fixtures only: no inventory, application quit, or process signalling.
    let parents: [Int32: Int32] = [1: 0, 10: 1, 20: 10, 21: 20, 30: 1, 31: 30, 40: 1]
    // Development builds also protect the ancestors (terminal/IDE) of the exam's roots.
    precondition(relatedPids(parents: parents, roots: [20, 30], includeAncestors: true) == [1, 10, 20, 21, 30, 31])
    precondition(!relatedPids(parents: parents, roots: [20], includeAncestors: true).contains(40))
    // Packaged builds protect only the roots and their descendants: the launching app (10) and
    // launchd (1) are not related, so an AI/remote-tool launcher stays a normal quittable app.
    precondition(relatedPids(parents: parents, roots: [20, 30], includeAncestors: false) == [20, 21, 30, 31])
    precondition(!relatedPids(parents: parents, roots: [20], includeAncestors: false).contains(10))
    precondition(!relatedPids(parents: parents, roots: [20], includeAncestors: false).contains(1))
    precondition(relatedPids(parents: [10: 11, 11: 10], roots: [10], includeAncestors: true) == [10, 11])
    precondition(relatedPids(parents: [10: 11, 11: 10], roots: [10], includeAncestors: false) == [10, 11])
    precondition(temporaryExemptionNames.count == temporaryExemptions.count)
    precondition(temporaryExemptions.contains("com.apple.Terminal"))
    precondition(temporaryExemptions.contains("com.openai.codex"))
    precondition(!protectedIds.contains("com.apple.Terminal"))
    precondition(protectedIds.contains("com.googlecode.iterm2"))
    // Strict mode exempts no development/AI/IDE app; demo exempts all of them.
    for id in temporaryExemptions {
        precondition(!isTemporaryExempt(id, demo: false))
        precondition(isTemporaryExempt(id, demo: true))
    }
    precondition(temporaryExemptions.contains("com.google.antigravity"))
    precondition(!baselineExemptions.contains("com.google.antigravity"))
    precondition(!protectedIds.contains("com.google.antigravity"))
    precondition(baselineExemptions.allSatisfy { $0.hasPrefix("com.apple.") })
    precondition(clampLevel(1.5) == 1.0 && clampLevel(-0.2) == 0.0 && clampLevel(0.4) == 0.4)
    precondition(clampLevel(Double.nan) == nil && clampLevel(Double.infinity) == nil)
    // Camera classifier: transport type + plug-in -> kind (fixtures from a real Intel MacBook).
    let ext = "AVCaptureDeviceTypeExternal"
    func kind(_ type: String, _ transport: String?, _ plugIn: String?) -> String {
        return classifyCamera(CameraFacts(deviceType: type, transport: transport.map(fourCC), plugInBundleId: plugIn)).kind
    }
    precondition(fourCCText(fourCC("usb ")) == "usb" && fourCCText(0) == "unknown" && fourCCText(fourCC("virt")) == "virt")
    precondition(kind(builtInDeviceType, "usb ", "com.apple.cmio.uvcassistantextension") == "builtin")
    precondition(kind(builtInDeviceType, "bltn", "com.apple.cmio.uvcassistantextension") == "builtin")
    precondition(kind(builtInDeviceType, "bltn", nil) == "builtin")
    precondition(kind(ext, "usb ", "com.apple.cmio.uvcassistantextension") == "usb")
    precondition(kind(ext, "thun", "com.apple.cmio.uvcassistantextension") == "usb")
    precondition(kind(ext, "usb ", nil) == "unknown")
    precondition(kind(ext, "othr", continuityPlugIn) == "continuity")
    precondition(kind(ext, nil, continuityPlugIn) == "continuity")
    precondition(kind("AVCaptureDeviceTypeContinuityCamera", nil, nil) == "continuity")
    // Virtual: transport 'virt' wins over everything, including a built-in device type or Apple plug-in.
    precondition(kind(ext, "virt", "com.obsproject.obs-studio.mac-camera-extension") == "virtual")
    precondition(kind(builtInDeviceType, "virt", "com.apple.cmio.uvcassistantextension") == "virtual")
    precondition(kind(ext, "virt", nil) == "virtual")
    // Third-party Camera Extension / DAL plug-in without a physical transport is virtual (Camo, mmhmm...).
    precondition(kind(ext, nil, "com.reincubate.camo.extension") == "virtual")
    precondition(kind(ext, "othr", "com.example.cam") == "virtual")
    // A third-party driver claiming a physical bus is not trusted as hardware, but not locked out.
    precondition(kind(ext, "usb ", "com.example.vendor-driver") == "unknown")
    precondition(kind(builtInDeviceType, "bltn", "com.example.fake") == "unknown")
    precondition(kind(ext, "usb ", "com.apple.cmio.iOSScreenCaptureAssistant") == "virtual")
    precondition(kind(ext, nil, nil) == "unknown")
    precondition(kind(ext, "bltn", "com.apple.cmio.uvcassistantextension") == "unknown")
    print("native policy checks passed (fixtures only)")
    exit(0)
}

// Manual probe (read-only): `app-control --brightness-get` prints the built-in display level.
if CommandLine.arguments.dropFirst().elementsEqual(["--brightness-get"]) {
    let reply = brightnessReply(Request(action: "brightness-get", hostPid: getppid(), hostExecutable: "", target: nil, demo: nil, level: nil, development: nil))
    if let output = try? JSONEncoder().encode(reply) { FileHandle.standardOutput.write(output) }
    exit(0)
}

// Manual probe (read-only, no camera stream): `app-control --camera-list` prints the classified cameras.
if CommandLine.arguments.dropFirst().elementsEqual(["--camera-list"]) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    if let output = try? encoder.encode(Reply(cameras: cameraInventory())) { FileHandle.standardOutput.write(output) }
    exit(0)
}

let response: Reply
do {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    guard input.count <= 16384 else { throw Failure.unavailable }
    response = try run(JSONDecoder().decode(Request.self, from: input))
} catch {
    response = Reply(error: "Native app discovery or identity verification is unavailable. No application was closed.")
}
if let output = try? JSONEncoder().encode(response) { FileHandle.standardOutput.write(output) }
