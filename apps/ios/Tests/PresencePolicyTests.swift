import XCTest
@testable import PresenceCore

final class PresencePolicyTests: XCTestCase {
    func testInactiveAndOldGenerationNeverPermitPings() {
        var gate = ForegroundGate()
        XCTAssertFalse(gate.permits(0))
        gate.transition(active: true)
        let active = gate.generation
        XCTAssertTrue(gate.permits(active))
        gate.transition(active: false)
        XCTAssertFalse(gate.permits(active))
        XCTAssertFalse(gate.permits(gate.generation))
        gate.transition(active: true)
        XCTAssertFalse(gate.permits(active))
        XCTAssertTrue(gate.permits(gate.generation))
    }
    func testPairingTransportAndCredentialValidation() throws {
        let code = String(repeating: "a", count: 43)
        let link = "examcompanion://pair?origin=http%3A%2F%2F192.168.1.8%3A5173&code=\(code)"
        XCTAssertEqual(try PairingLink(link, allowHTTP: true).origin.host, "192.168.1.8")
        XCTAssertThrowsError(try PairingLink(link, allowHTTP: false))
        for host in ["localhost", "127.0.0.1", "8.8.8.8", "192.168.999.1"] {
            XCTAssertThrowsError(try PairingLink("examcompanion://pair?origin=http://\(host):5173&code=\(code)", allowHTTP: true))
        }
        XCTAssertThrowsError(try PairingLink(link + "&code=duplicate", allowHTTP: true))
        XCTAssertThrowsError(try PairingLink(link.replacingOccurrences(of: code, with: "short"), allowHTTP: true))
        XCTAssertNoThrow(try PairingLink("examcompanion://pair?origin=https://exam.example.test&code=\(code)", allowHTTP: false))
    }
}
