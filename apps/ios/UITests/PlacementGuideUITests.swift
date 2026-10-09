import XCTest

/// Walks the placement guide in DEBUG placeholder mode (`-placementGuideDebug`): no camera or laptop needed.
final class PlacementGuideUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
        app = XCUIApplication()
        app.launchArguments += ["-placementGuideDebug"]
        app.launch()
    }

    override func tearDown() {
        XCUIDevice.shared.orientation = .portrait
    }

    func testWalkThroughGuideAndRepositionOverlay() {
        XCTAssertTrue(app.staticTexts["Turn your phone sideways"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Step 1 of 3"].exists)

        // Rotating to landscape advances automatically.
        XCUIDevice.shared.orientation = .landscapeLeft
        XCTAssertTrue(app.staticTexts["Place the phone beside your laptop"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Step 2 of 3"].exists)

        let next = app.buttons["placement-next"]
        XCTAssertTrue(next.waitForExistence(timeout: 5))
        next.tap()
        XCTAssertTrue(app.staticTexts["Check the view"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.otherElements["tick-frame"].exists || app.staticTexts["You are in frame: not yet"].exists)

        let simulate = app.switches["placement-simulate"]
        XCTAssertTrue(simulate.waitForExistence(timeout: 5))
        simulate.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()

        // All ticks green for 3 s -> success.
        XCTAssertTrue(app.staticTexts["Looks good — keep the phone here"].waitForExistence(timeout: 15))

        // After setup, putting the phone down flat / back to portrait shows the gentle overlay.
        XCUIDevice.shared.orientation = .portrait
        XCTAssertTrue(app.staticTexts["Put the phone back in position"].waitForExistence(timeout: 15))
    }

    func testNextButtonAdvancesWithoutRotation() {
        XCTAssertTrue(app.staticTexts["Turn your phone sideways"].waitForExistence(timeout: 10))
        app.buttons["placement-next"].tap()
        XCTAssertTrue(app.staticTexts["Place the phone beside your laptop"].waitForExistence(timeout: 5))
    }
}
