import AppKit
import Foundation
import Darwin

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
}
struct Reply: Encodable {
    var apps: [Entry]? = nil
    var status: String? = nil
    var error: String? = nil
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

func run(_ request: Request) throws -> Reply {
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
    print("native policy checks passed (fixtures only)")
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
