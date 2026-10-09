import XCTest
#if canImport(PresenceCore)
@testable import PresenceCore
#endif

final class DeskCameraPolicyTests: XCTestCase {
    func testNoPeopleIsNotFramedOk() {
        XCTAssertFalse(DeskCameraPolicy.status(personBoxes: [], handPoints: []).framingOk)
    }
    func testOnePersonInFrame() {
        let s = DeskCameraPolicy.status(personBoxes: [CGRect(x: 0.2, y: 0.1, width: 0.5, height: 0.7)], handPoints: [])
        XCTAssertEqual(s, DeskCameraStatus(people: 1, handsVisible: false, framingOk: true))
    }
    func testTinyOrFullFrameBoxIsNotOk() {
        XCTAssertFalse(DeskCameraPolicy.framingOk(personBoxes: [CGRect(x: 0.4, y: 0.4, width: 0.1, height: 0.1)]))
        XCTAssertFalse(DeskCameraPolicy.framingOk(personBoxes: [CGRect(x: 0, y: 0, width: 1, height: 1)]))
    }
    func testHandsOnlyCountNearKeyboard() {
        XCTAssertTrue(DeskCameraPolicy.handsNearKeyboard(handPoints: [CGPoint(x: 0.5, y: 0.2)]))
        XCTAssertFalse(DeskCameraPolicy.handsNearKeyboard(handPoints: [CGPoint(x: 0.5, y: 0.9)]))
    }
    func testSendThrottle() {
        let t = Date()
        XCTAssertTrue(DeskCameraPolicy.shouldSend(now: t, lastSent: nil))
        XCTAssertFalse(DeskCameraPolicy.shouldSend(now: t.addingTimeInterval(4.9), lastSent: t))
        XCTAssertTrue(DeskCameraPolicy.shouldSend(now: t.addingTimeInterval(5), lastSent: t))
    }
}
