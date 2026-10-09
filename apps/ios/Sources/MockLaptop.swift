#if DEBUG
import SwiftUI

/// DEBUG-only stand-in for the exam laptop, used by Simulator UI tests (`-UITestMockLaptop YES`).
/// It intercepts the app's own URLSession requests (no sockets, no network), answers the pairing and
/// presence endpoints, and records what the phone posted so a test can assert on it.
/// `-UITestMockOutage YES` makes the laptop stop answering for `outageSeconds` after the second
/// heartbeat, to exercise the "laptop isn't responding" and automatic reconnect states.
@MainActor final class MockLaptop: ObservableObject {
    static let shared = MockLaptop()
    nonisolated static var enabled: Bool { UserDefaults.standard.bool(forKey: "UITestMockLaptop") }
    nonisolated static var outageEnabled: Bool { UserDefaults.standard.bool(forKey: "UITestMockOutage") }
    nonisolated static let outageSeconds: TimeInterval = 14
    @Published private(set) var summary = "mock: idle"
    private var events: [String] = []
    private var heartbeats = 0

    nonisolated static func record(_ event: String) {
        DispatchQueue.main.async { MockLaptop.shared.append(event) }
    }
    private func append(_ event: String) {
        if event == "heartbeat" { heartbeats += 1 } else { events.append(event) }
        summary = "mock: heartbeats=\(heartbeats) | " + events.suffix(10).joined(separator: " | ")
    }
}

final class MockLaptopProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var sequence = 0
    private static var heartbeatCount = 0
    private static var outageUntil: Date?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    private var bodyJSON: [String: Any] {
        var data = request.httpBody
        if data == nil, let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var collected = Data(); var buffer = [UInt8](repeating: 0, count: 16384)
            while stream.hasBytesAvailable {
                let n = stream.read(&buffer, maxLength: buffer.count)
                if n <= 0 { break }
                collected.append(buffer, count: n)
            }
            data = collected
        }
        return (data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]) ?? [:]
    }

    /// True while the simulated outage runs; logs its start and end once.
    private static func inOutage() -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard let until = outageUntil else { return false }
        if Date() < until { return true }
        outageUntil = .distantPast
        if until != .distantPast { MockLaptop.record("outage-end") }
        return false
    }

    override func startLoading() {
        let path = request.url?.path ?? ""
        var reply: [String: Any] = ["ok": true]
        var status = 200
        let body = bodyJSON
        switch (request.httpMethod ?? "GET", path) {
        case ("POST", "/exam/phone-presence/claim"):
            MockLaptop.record("claim")
            reply = ["credential": String(repeating: "B", count: 43), "attemptId": "mock-attempt-1"]
        case ("POST", "/exam/phone-presence/challenge"):
            if Self.inOutage() { status = 503; break }
            Self.lock.lock(); Self.sequence += 1; let n = Self.sequence; Self.lock.unlock()
            reply = ["challenge": String(repeating: "C", count: 43), "sequence": n]
        case ("POST", "/exam/phone-presence/heartbeat"):
            if Self.inOutage() { status = 503; break }
            MockLaptop.record("heartbeat")
            if body["leftApp"] as? Bool == true { MockLaptop.record("leftApp") }
            Self.lock.lock()
            Self.heartbeatCount += 1
            let startOutage = MockLaptop.outageEnabled && Self.heartbeatCount == 2 && Self.outageUntil == nil
            if startOutage { Self.outageUntil = Date().addingTimeInterval(MockLaptop.outageSeconds) }
            Self.lock.unlock()
            if startOutage { MockLaptop.record("outage-start") }
        default: break // HEAD probe etc.
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil,
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: (try? JSONSerialization.data(withJSONObject: reply)) ?? Data())
        client?.urlProtocolDidFinishLoading(self)
    }
}

struct MockLaptopLog: View {
    @ObservedObject private var mock = MockLaptop.shared
    var body: some View {
        Text(mock.summary).font(.caption2.monospaced()).accessibilityIdentifier("mock-log")
    }
}
#endif
