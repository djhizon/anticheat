import XCTest
@testable import PresenceCore

final class PlacementPolicyTests: XCTestCase {
    func testTilt() {
        XCTAssertEqual(PlacementPolicy.tiltDegrees(gravityZ: 0), 0, accuracy: 0.01)
        XCTAssertEqual(PlacementPolicy.tiltDegrees(gravityZ: -1), 90, accuracy: 0.01)
        XCTAssertTrue(PlacementPolicy.tiltOk(PlacementPolicy.tiltDegrees(gravityZ: 0.2)))   // ~11.5 deg
        XCTAssertFalse(PlacementPolicy.tiltOk(PlacementPolicy.tiltDegrees(gravityZ: 0.4)))  // ~23.6 deg
        XCTAssertTrue(PlacementPolicy.tiltOk(nil))
    }
    func testLandscapeDetection() {
        XCTAssertEqual(PlacementPolicy.isLandscape(gravityX: 0.98, gravityY: 0.1), true)
        XCTAssertEqual(PlacementPolicy.isLandscape(gravityX: -0.98, gravityY: 0.1), true)
        XCTAssertEqual(PlacementPolicy.isLandscape(gravityX: 0.05, gravityY: -0.99), false)
        XCTAssertNil(PlacementPolicy.isLandscape(gravityX: 0.1, gravityY: 0.1))
    }
    func testLightingAndHands() {
        XCTAssertFalse(PlacementPolicy.lightingOk(meanLuma: 0.05))
        XCTAssertTrue(PlacementPolicy.lightingOk(meanLuma: 0.5))
        XCTAssertFalse(PlacementPolicy.lightingOk(meanLuma: 0.97))
        XCTAssertTrue(PlacementPolicy.handsInLowerHalf([CGPoint(x: 0.5, y: 0.3)]))
        XCTAssertFalse(PlacementPolicy.handsInLowerHalf([CGPoint(x: 0.5, y: 0.8)]))
    }
    func testGravityAngle() {
        XCTAssertEqual(PlacementPolicy.angleBetween((1, 0, 0), (0, 1, 0)), 90, accuracy: 0.01)
        XCTAssertEqual(PlacementPolicy.angleBetween((1, 0, 0), (1, 0, 0)), 0, accuracy: 0.01)
    }
    func testSteadyNeedsFullWindowAndLowMotion() {
        var t = SteadyTracker()
        for i in 0..<20 { t.add(time: Double(i) * 0.1, magnitude: 0.02) }
        XCTAssertFalse(t.isSteady(at: 1.9))
        for i in 20...32 { t.add(time: Double(i) * 0.1, magnitude: 0.02) }
        XCTAssertTrue(t.isSteady(at: 3.2))
        t.add(time: 3.3, magnitude: 1.0)
        XCTAssertFalse(t.isSteady(at: 3.3))
    }
    func testHoldTimerResetsOnRed() {
        var h = HoldTimer()
        XCTAssertEqual(h.update(ok: true, at: 0), 0, accuracy: 0.001)
        XCTAssertEqual(h.update(ok: true, at: 1.5), 0.5, accuracy: 0.001)
        XCTAssertEqual(h.update(ok: false, at: 2), 0)
        XCTAssertEqual(h.update(ok: true, at: 2.1), 0, accuracy: 0.001)
        XCTAssertEqual(h.update(ok: true, at: 5.2), 1, accuracy: 0.001)
    }
}
