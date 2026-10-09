import AppKit
import Foundation
import Darwin
import CoreGraphics
import IOKit

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
}
struct Reply: Encodable {
    var apps: [Entry]? = nil
    var status: String? = nil
    var error: String? = nil
    // Built-in display brightness (brightness-get / brightness-set); 0...1.
    var supported: Bool? = nil
    var brightness: Double? = nil
    var method: String? = nil
}
enum Failure: Error { case unavailable }

// Development exemptions apply in demo mode only; strict mode never honours them.
// Every AI assistant / IDE belongs here (never in the baseline), so Strict can close it.
let temporaryExemptions: Set<String> = [
    "com.apple.Terminal", "com.openai.chat", "com.openai.codex", "com.google.antigravity"
]
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
    "com.googlecode.iterm2", "com.exam-anti-cheat.desktop"
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

func relatedPids(parents: [Int32: Int32], roots: Set<Int32>) -> Set<Int32> {
    var protected = roots
    for root in roots {
        var current = root
        var visited: Set<Int32> = []
        while let parent = parents[current], parent > 0, !visited.contains(parent) {
            protected.insert(parent)
            visited.insert(parent)
            current = parent
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

func dependencyPids(_ hostPid: Int32) throws -> Set<Int32> {
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
    return relatedPids(parents: parents, roots: roots)
}

func inventory(_ request: Request) throws -> [Entry] {
    guard getppid() == request.hostPid,
          let host = NSRunningApplication(processIdentifier: request.hostPid),
          let hostIdentity = identity(host),
          hostIdentity.executablePath == URL(fileURLWithPath: request.hostExecutable).resolvingSymlinksInPath().path
    else { throw Failure.unavailable }
    let dependencies = try dependencyPids(request.hostPid)
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

func run(_ request: Request) throws -> Reply {
    if request.action == "brightness-get" || request.action == "brightness-set" {
        guard getppid() == request.hostPid else { throw Failure.unavailable }
        return brightnessReply(request)
    }
    guard ["list", "quit", "force"].contains(request.action) else { throw Failure.unavailable }
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
    precondition(relatedPids(parents: parents, roots: [20, 30]) == [1, 10, 20, 21, 30, 31])
    precondition(!relatedPids(parents: parents, roots: [20]).contains(40))
    precondition(relatedPids(parents: [10: 11, 11: 10], roots: [10]) == [10, 11])
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
    print("native policy checks passed (fixtures only)")
    exit(0)
}

// Manual probe (read-only): `app-control --brightness-get` prints the built-in display level.
if CommandLine.arguments.dropFirst().elementsEqual(["--brightness-get"]) {
    let reply = brightnessReply(Request(action: "brightness-get", hostPid: getppid(), hostExecutable: "", target: nil, demo: nil, level: nil))
    if let output = try? JSONEncoder().encode(reply) { FileHandle.standardOutput.write(output) }
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
