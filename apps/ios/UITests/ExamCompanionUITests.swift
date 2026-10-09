import XCTest

/// Simulator smoke tests. They never need a laptop: the "unreachable" case points at a black-hole
/// private address. Set TEST_RUNNER_SCREENSHOT_DIR to also save screenshots; set TEST_RUNNER_MOCK_ORIGIN
/// (a private-IPv4 http origin of a mock laptop) to run the paired/desk-camera test.
final class ExamCompanionUITests: XCTestCase {
    private let code = String(repeating: "A", count: 43)
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launch()
    }

    private func shot(_ name: String) {
        let image = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: image)
        attachment.name = name; attachment.lifetime = .keepAlways
        add(attachment)
        if let dir = ProcessInfo.processInfo.environment["SCREENSHOT_DIR"] {
            try? image.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
        }
    }

    private func enterLink(_ link: String) {
        let disclosure = app.buttons["Enter pairing link manually"]
        XCTAssertTrue(disclosure.waitForExistence(timeout: 5))
        let field = app.textFields["examcompanion://pair?…"]
        if !field.exists { app.swipeUp(); disclosure.tap() }
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        shot("02-pairing-input")
        field.tap(); field.typeText(link)
        app.swipeUp()
        app.buttons["Use pairing link"].tap()
    }

    func testLaunchShowsUnpairedState() {
        XCTAssertTrue(app.staticTexts["Stay here during your exam"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["presence-status"].label, "Scan the laptop QR to pair.")
        XCTAssertFalse(app.buttons["Stop and forget pairing"].exists)
        shot("01-unpaired")
    }

    func testInvalidLinkShowsError() {
        enterLink("not a link")
        app.swipeDown(); app.swipeDown()
        let status = app.staticTexts["presence-status"]
        XCTAssertTrue(status.waitForExistence(timeout: 5))
        XCTAssertTrue(status.label.hasPrefix("That pairing link didn't work"), status.label)
        XCTAssertFalse(app.buttons["Connect to laptop"].exists)
        shot("03-invalid-link")
    }

    func testUnreachableHostReportsCouldNotReach() {
        enterLink("examcompanion://pair?origin=http://10.255.255.1&code=\(code)")
        app.swipeDown(); app.swipeDown()
        XCTAssertTrue(app.staticTexts["presence-status"].label.hasPrefix("Confirm the laptop address"))
        shot("04-pending-confirm")
        app.switches.element(boundBy: 0).tap()   // consent
        app.swipeUp()
        app.switches.element(boundBy: 1).tap()   // HTTP demo acknowledgement
        let connect = app.buttons["Connect to laptop"]
        XCTAssertTrue(connect.isEnabled)
        connect.tap()
        app.swipeDown(); app.swipeDown()
        let status = app.staticTexts["presence-status"]
        expectation(for: NSPredicate(format: "label BEGINSWITH 'Could not reach the laptop'"), evaluatedWith: status)
        waitForExpectations(timeout: 60)
        shot("05-unreachable")
        XCTAssertFalse(app.buttons["Stop and forget pairing"].exists)
    }

    func testPairedDeskCameraShowsUnavailableOnSimulator() throws {
        guard let origin = ProcessInfo.processInfo.environment["MOCK_ORIGIN"] else {
            throw XCTSkip("Set TEST_RUNNER_MOCK_ORIGIN to a mock laptop origin to run this test.")
        }
        enterLink("examcompanion://pair?origin=\(origin)&code=\(code)")
        app.swipeDown(); app.swipeDown()
        app.switches.element(boundBy: 0).tap()
        app.swipeUp()
        app.switches.element(boundBy: 1).tap()
        app.buttons["Connect to laptop"].tap()
        let toggle = app.switches["Desk camera (optional)"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 20))
        shot("06-paired")
        toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
        let message = app.staticTexts["Rear camera is unavailable (the Simulator has no camera)."]
        XCTAssertTrue(message.waitForExistence(timeout: 10))
        shot("07-camera-unavailable")
    }
}
