import XCTest
#if canImport(PresenceCore)
@testable import PresenceCore
#endif

final class ReliabilityPolicyTests: XCTestCase {
    func testFailureClassification() {
        for code in [401, 403, 404, 410] { XCTAssertEqual(FailurePolicy.classify(statusCode: code), .definiteRejection) }
        for code in [408, 409, 429, 500, 502, 503] { XCTAssertEqual(FailurePolicy.classify(statusCode: code), .transient) }
    }
    func testPairingRetrySchedule() {
        XCTAssertEqual((1...5).map { PairingRetryPolicy.delayAfter(attempt: $0) }, [1, 2, 4, 4, nil])
        XCTAssertNil(PairingRetryPolicy.delayAfter(attempt: 0))
    }
    func testHeartbeatSchedulesFixedPeriod() {
        XCTAssertEqual(HeartbeatSchedule.sleepSeconds(elapsed: 0.3), 1.7, accuracy: 1e-9)
        XCTAssertEqual(HeartbeatSchedule.sleepSeconds(elapsed: 2), 0)
        XCTAssertEqual(HeartbeatSchedule.sleepSeconds(elapsed: 5), 0)
        XCTAssertEqual(HeartbeatSchedule.sleepSeconds(elapsed: -1), 2)
    }
    func testSingleRejectionRetriesOnceThenGivesUp() {
        var tracker = RejectionTracker()
        XCTAssertEqual(tracker.recordRejection(), .retryOnce)
        XCTAssertEqual(tracker.recordRejection(), .giveUp)
        tracker.recordSuccess()
        XCTAssertEqual(tracker.recordRejection(), .retryOnce)
    }
    func testIdleTimer() {
        XCTAssertTrue(IdleTimerPolicy.keepAwake(active: true, paired: true, reconnecting: false))
        XCTAssertTrue(IdleTimerPolicy.keepAwake(active: true, paired: false, reconnecting: true))
        XCTAssertFalse(IdleTimerPolicy.keepAwake(active: true, paired: false, reconnecting: false))
        XCTAssertFalse(IdleTimerPolicy.keepAwake(active: false, paired: true, reconnecting: true))
    }
}

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
