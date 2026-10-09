#if DEBUG
import SwiftUI
import UIKit

/// DEBUG-only stand-in for the exam laptop, used by Simulator UI tests (`-UITestMockLaptop YES`).
/// It intercepts the app's own URLSession requests (no sockets, no network), answers the pairing and
/// presence endpoints, and records what the phone posted so a test can assert on it.
@MainActor final class MockLaptop: ObservableObject {
    static let shared = MockLaptop()
    nonisolated static var enabled: Bool { UserDefaults.standard.bool(forKey: "UITestMockLaptop") }
    @Published private(set) var summary = "mock: idle"
    private var events: [String] = []
    private var heartbeats = 0

    nonisolated func record(_ event: String) {
        DispatchQueue.main.async { MockLaptop.shared.append(event) }
    }
    private func append(_ event: String) {
        if event == "heartbeat" { heartbeats += 1 } else { events.append(event) }
        summary = "mock: heartbeats=\(heartbeats) | " + events.suffix(14).joined(separator: " | ")
    }
}

final class MockLaptopProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var sequence = 0
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

    override func startLoading() {
        let path = request.url?.path ?? ""
        var reply: [String: Any] = ["ok": true]
        let body = bodyJSON
        switch (request.httpMethod ?? "GET", path) {
        case ("POST", "/exam/phone-presence/claim"):
            MockLaptop.shared.record("claim")
            reply = ["credential": String(repeating: "B", count: 43), "attemptId": "mock-attempt-1"]
        case ("POST", "/exam/phone-presence/challenge"):
            Self.lock.lock(); Self.sequence += 1; let n = Self.sequence; Self.lock.unlock()
            reply = ["challenge": String(repeating: "C", count: 43), "sequence": n]
        case ("POST", "/exam/phone-presence/heartbeat"):
            MockLaptop.shared.record("heartbeat")
        case ("POST", "/exam/phone-presence/desk-camera"):
            let flags = ["extraPerson", "extraHands", "textVisible", "cameraObstructed"].filter { body[$0] as? Bool == true }
            let hints = (body["objectHints"] as? [String] ?? []).joined(separator: "+")
            MockLaptop.shared.record("desk-camera flags=\(flags.joined(separator: "+")) hints=\(hints)")
        case ("POST", let p) where p.hasPrefix("/exam/attempts/") && p.hasSuffix("/evidence"):
            let b64 = body["imageJpegBase64"] as? String ?? ""
            let data = Data(base64Encoded: b64) ?? Data()
            let isJPEG = data.starts(with: [0xFF, 0xD8])
            let width = UIImage(data: data).map { Int($0.size.width) } ?? 0
            let trigger = body["trigger"] as? String ?? "?"
            let source = body["source"] as? String ?? "?"
            MockLaptop.shared.record("evidence trigger=\(trigger) source=\(source) jpeg=\(isJPEG) narrow=\(width > 0 && width <= 640) small=\(data.count <= 150_000) auth=\(body["credential"] != nil)")
        default: break // HEAD probe etc.
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
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
