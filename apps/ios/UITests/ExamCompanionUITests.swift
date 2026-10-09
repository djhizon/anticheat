import XCTest

/// Simulator UI tests. They never need a real laptop: the mock laptop (`-UITestMockLaptop YES`)
/// answers inside the app, and the "unreachable" case points at a black-hole private address.
/// Set SCREENSHOT_DIR (TEST_RUNNER_SCREENSHOT_DIR) to also save screenshots.
final class ExamCompanionUITests: XCTestCase {
    private let code = String(repeating: "A", count: 43)
    private var mockLink: String { "examcompanion://pair?origin=http://192.168.50.10&code=\(code)" }
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
    }

    private func launch(mock: Bool = false, outage: Bool = false) {
        app.launchArguments = []
        if mock { app.launchArguments += ["-UITestMockLaptop", "YES"] }
        if outage { app.launchArguments += ["-UITestMockOutage", "YES"] }
        app.launch()
    }

    private var status: XCUIElement { app.staticTexts["presence-status"] }

    private func waitForStatus(_ format: String, _ value: String, timeout: TimeInterval) {
        let predicate = NSPredicate(format: "label \(format) %@", value)
        let done = expectation(for: predicate, evaluatedWith: status)
        if XCTWaiter().wait(for: [done], timeout: timeout) != .completed {
            XCTFail("Timed out waiting for status \(format) '\(value)'. Status: \(status.exists ? status.label : "<none>")")
        }
    }

    private func waitForMockLog(containing needle: String, timeout: TimeInterval = 30) {
        let log = app.staticTexts["mock-log"]
        XCTAssertTrue(log.waitForExistence(timeout: 10))
        let done = expectation(for: NSPredicate(format: "label CONTAINS %@", needle), evaluatedWith: log)
        if XCTWaiter().wait(for: [done], timeout: timeout) != .completed {
            XCTFail("Timed out waiting for \(needle). Mock laptop saw: \(log.label)")
        }
    }

    /// The fallback shown when the camera can't be used (always the case in the Simulator).
    private func pasteLink(_ link: String) {
        let field = app.textFields["pairing-link-field"]
        if !field.waitForExistence(timeout: 3) { app.buttons["Paste a pairing link instead"].tap() }
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap(); field.typeText(link)
        app.buttons["Use pairing link"].tap()
    }

    private func pairWithMockLaptop() {
        pasteLink(mockLink)
        XCTAssertTrue(app.staticTexts["Paired with your laptop"].waitForExistence(timeout: 10))
        waitForStatus("==", "Connected to your laptop", timeout: 15)
    }

    // MARK: - Tests

    func testLaunchUnpairedOpensScannerWithPasteFallback() {
        launch()
        XCTAssertTrue(app.staticTexts["Scan the QR code on your laptop"].waitForExistence(timeout: 5))
        // The Simulator has no camera, so the scanner says so and offers the paste field instead.
        let unavailable = app.staticTexts["Camera unavailable — paste link"]
        let scanner = app.otherElements["qr-scanner"]
        XCTAssertTrue(unavailable.waitForExistence(timeout: 5) || scanner.exists)
        if unavailable.exists { XCTAssertTrue(app.textFields["pairing-link-field"].exists) }
        XCTAssertEqual(status.label, "Point the camera at the QR code on your laptop.")
        XCTAssertFalse(app.staticTexts["Paired with your laptop"].exists)
        shot("01-scanner-unpaired")
    }

    func testInvalidLinkShowsHintAndKeepsScanning() {
        launch()
        pasteLink("not a link")
        let hint = app.staticTexts["scan-hint"]
        XCTAssertTrue(hint.waitForExistence(timeout: 5))
        XCTAssertTrue(hint.label.hasPrefix("That isn't an exam pairing code"), hint.label)
        XCTAssertTrue(app.staticTexts["Scan the QR code on your laptop"].exists)
        shot("02-invalid-link")
    }

    func testUnreachableLaptopTimesOutWithRetry() {
        launch()
        pasteLink("examcompanion://pair?origin=http://10.255.255.1&code=\(code)")
        waitForStatus("==", "Connecting to laptop…", timeout: 3)
        shot("03-connecting")
        let started = Date()
        let retry = app.buttons["Try again"]
        XCTAssertTrue(retry.waitForExistence(timeout: 15))
        XCTAssertLessThan(Date().timeIntervalSince(started), 12, "the 5 s connect budget should end promptly")
        XCTAssertTrue(status.label.hasPrefix("Couldn't reach your laptop"), status.label)
        shot("04-connect-failed")
        retry.tap()
        waitForStatus("==", "Connecting to laptop…", timeout: 3)
        XCTAssertTrue(app.buttons["Scan again"].waitForExistence(timeout: 15))
        app.buttons["Scan again"].tap()
        XCTAssertTrue(app.staticTexts["Scan the QR code on your laptop"].waitForExistence(timeout: 5))
    }

    /// A pairing link opened from outside the app (the system Camera app or a tapped link).
    func testDeepLinkPairsWithMockLaptop() throws {
        launch(mock: true)
        XCTAssertTrue(app.staticTexts["Scan the QR code on your laptop"].waitForExistence(timeout: 5))
        guard #available(iOS 16.4, *) else { throw XCTSkip("XCUIDevice.system.open(_:) needs iOS 16.4") }
        // Through the system, like a link tapped in the Camera app; accept the "Open in" prompt if shown.
        XCUIDevice.shared.system.open(URL(string: mockLink)!)
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let openButton = springboard.buttons["Open"]
        if openButton.waitForExistence(timeout: 5) { openButton.tap() }
        XCTAssertTrue(app.staticTexts["Paired with your laptop"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Keep this app open and put the phone face-down on the desk."].exists)
        waitForStatus("==", "Connected to your laptop", timeout: 15)
        waitForMockLog(containing: "claim")
        let log = app.staticTexts["mock-log"]
        let beating = expectation(for: NSPredicate(format: "label MATCHES %@", "mock: heartbeats=([2-9]|[1-9][0-9]+) .*"),
                                  evaluatedWith: log)
        XCTAssertEqual(XCTWaiter().wait(for: [beating], timeout: 15), .completed, log.label)
        shot("05-paired")
    }

    func testHeartbeatLossShowsLaptopNotRespondingThenReconnects() {
        launch(mock: true, outage: true)
        pairWithMockLaptop()
        waitForMockLog(containing: "outage-start")
        waitForStatus("BEGINSWITH", "Your laptop isn't responding", timeout: 15)
        shot("06-laptop-not-responding")
        XCTAssertTrue(app.staticTexts["Paired with your laptop"].exists, "a blip never unpairs")
        waitForStatus("==", "Connected to your laptop", timeout: 20)
        waitForMockLog(containing: "outage-end")
        shot("07-reconnected")
    }

    func testBackgroundThenForegroundReportsLeftApp() {
        launch(mock: true)
        pairWithMockLaptop()
        XCTAssertFalse(app.staticTexts["mock-log"].label.contains("leftApp"))
        XCUIDevice.shared.press(.home)
        XCTAssertTrue(app.wait(for: .runningBackground, timeout: 10) || app.wait(for: .runningBackgroundSuspended, timeout: 5))
        sleep(2)
        app.activate()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10))
        waitForMockLog(containing: "leftApp")
        waitForStatus("==", "Connected to your laptop", timeout: 15)
        XCTAssertTrue(app.staticTexts["Paired with your laptop"].exists)
        shot("08-back-from-background")
    }

    func testUnpairReturnsToScanner() {
        launch(mock: true)
        pairWithMockLaptop()
        app.buttons["Unpair"].tap()
        let confirm = app.sheets.buttons["Unpair"]
        if confirm.waitForExistence(timeout: 3) {
            confirm.tap()
        } else {
            app.buttons.matching(identifier: "Unpair").element(boundBy: 1).tap()
        }
        XCTAssertTrue(app.staticTexts["Scan the QR code on your laptop"].waitForExistence(timeout: 5))
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
}
