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

    /// Relaunch with the DEBUG-only hooks: a mock laptop answered inside the app (no network) and a
    /// drawn fixture frame fed through the real Vision pipeline instead of the camera.
    private func relaunch(fixture: String) {
        app.terminate()
        app.launchArguments = ["-UITestMockLaptop", "YES", "-UITestFixtureFrames", fixture]
        app.launch()
    }

    private func pairWithMockLaptop() {
        enterLink("examcompanion://pair?origin=http://192.168.50.10&code=\(code)")
        app.swipeDown(); app.swipeDown()
        app.switches.element(boundBy: 0).tap()
        app.swipeUp()
        app.switches.element(boundBy: 1).tap()
        app.buttons["Connect to laptop"].tap()
        let toggle = app.switches["Desk camera (optional)"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 20))
        toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
    }

    private func waitForMockLog(containing needle: String, timeout: TimeInterval = 45) -> String {
        let log = app.staticTexts["mock-log"]
        XCTAssertTrue(log.waitForExistence(timeout: 10))
        let predicate = NSPredicate(format: "label CONTAINS %@", needle)
        let done = expectation(for: predicate, evaluatedWith: log)
        if XCTWaiter().wait(for: [done], timeout: timeout) != .completed {
            XCTFail("Timed out waiting for \(needle). Mock laptop saw: \(log.label)")
        }
        return log.label
    }

    /// Drawn paper with large text in the desk area: Vision text recognition fires `textVisible` and the
    /// flag post carries it. textVisible has no server evidence trigger, so NO still is sent for it.
    func testFixtureTextFramePostsFlagWithoutSnapshot() {
        relaunch(fixture: "paper_text")
        pairWithMockLaptop()
        let log = waitForMockLog(containing: "desk-camera flags=textVisible")
        XCTAssertTrue(log.contains("claim"), log) // pairing went through the mock laptop
        XCTAssertFalse(log.contains("evidence trigger=textVisible"), log)
        shot("08-fixture-text-flag")
    }

    /// Baseline: one person, two hands, normal picture. Flags stay empty and no snapshot is sent.
    func testFixtureOnePersonBaselineSendsNoSnapshot() {
        relaunch(fixture: "one_person")
        pairWithMockLaptop()
        _ = waitForMockLog(containing: "desk-camera flags= hints=", timeout: 30)
        sleep(12)
        let final = app.staticTexts["mock-log"].label
        XCTAssertFalse(final.contains("evidence"), final)
        XCTAssertFalse(final.contains("flags=extra"), final)
        XCTAssertFalse(final.contains("flags=camera"), final)
    }

    /// Two people: debounced extraPerson flag plus one `extra_person` still (people counts injected by the fixture).
    func testFixtureTwoPeopleFlagsExtraPersonWithSnapshot() {
        relaunch(fixture: "two_people")
        pairWithMockLaptop()
        let log = waitForMockLog(containing: "evidence trigger=extra_person")
        XCTAssertTrue(log.contains("source=desk_camera jpeg=true narrow=true small=true auth=true"), log)
        let flags = waitForMockLog(containing: "flags=extraPerson")
        XCTAssertEqual(flags.components(separatedBy: "evidence trigger=extra_person").count - 1, 1, flags)
        shot("10-fixture-two-people")
    }

    /// Three hands: debounced extraHands flag. The server has no evidence trigger for it, so no still.
    func testFixtureExtraHandsFlagsWithoutSnapshot() {
        relaunch(fixture: "extra_hands")
        pairWithMockLaptop()
        let log = waitForMockLog(containing: "flags=extraHands")
        XCTAssertFalse(log.contains("evidence trigger=extra_hands"), log)
        shot("11-fixture-extra-hands")
    }

    /// A black frame: the luminance check flags `cameraObstructed` and sends one `left_frame` still.
    func testFixtureDarkFrameFlagsCameraObstructed() {
        relaunch(fixture: "dark")
        pairWithMockLaptop()
        let log = waitForMockLog(containing: "evidence trigger=left_frame")
        XCTAssertTrue(log.contains("source=desk_camera jpeg=true narrow=true small=true auth=true"), log)
        _ = waitForMockLog(containing: "desk-camera flags=cameraObstructed")
        shot("09-fixture-dark-evidence")
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
