import XCTest
#if canImport(PresenceCore)
@testable import PresenceCore
#endif

final class DeskCameraAnalysisTests: XCTestCase {
    private func person() -> CGRect { CGRect(x: 0.2, y: 0.1, width: 0.5, height: 0.7) }
    private func fast(people: Int = 1, faces: Int = 0, hands: Int = 0) -> FastObservation {
        var f = FastObservation()
        f.personBoxes = Array(repeating: person(), count: people)
        f.faces = faces
        f.handCount = hands
        return f
    }

    // MARK: second person
    func testExtraPersonNeedsOnePointFiveSeconds() {
        var a = DeskCameraAggregator()
        XCTAssertFalse(a.ingest(fast(people: 2), slow: nil, at: 0).status.extraPerson)
        XCTAssertFalse(a.ingest(fast(people: 2), slow: nil, at: 1.0).status.extraPerson)
        let out = a.ingest(fast(people: 2), slow: nil, at: 1.5)
        XCTAssertTrue(out.status.extraPerson)
        XCTAssertEqual(out.newTriggers, ["extraPerson"])
        XCTAssertTrue(a.ingest(fast(people: 2), slow: nil, at: 2.0).newTriggers.isEmpty) // edge only
    }
    func testSingleFrameBlipDoesNotFlagButIsInPeopleWindow() {
        var a = DeskCameraAggregator()
        _ = a.ingest(fast(people: 1), slow: nil, at: 0)
        let blip = a.ingest(fast(people: 2), slow: nil, at: 0.5)
        XCTAssertEqual(blip.status.people, 2) // windowed max
        XCTAssertFalse(blip.status.extraPerson)
        _ = a.ingest(fast(people: 1), slow: nil, at: 1.0)
        let later = a.ingest(fast(people: 2), slow: nil, at: 5.0)
        XCTAssertFalse(later.status.extraPerson)
    }
    func testFacesCombineWithPeopleBoxes() {
        var a = DeskCameraAggregator()
        for t in stride(from: 0.0, through: 1.5, by: 0.5) { _ = a.ingest(fast(people: 1, faces: 2), slow: nil, at: t) }
        XCTAssertTrue(a.ingest(fast(people: 1, faces: 2), slow: nil, at: 2.0).status.extraPerson)
    }
    func testExtraPersonSurvivesOneMissedFrameButClearsAfterGap() {
        var a = DeskCameraAggregator()
        for t in stride(from: 0.0, through: 1.5, by: 0.5) { _ = a.ingest(fast(people: 2), slow: nil, at: t) }
        XCTAssertTrue(a.ingest(fast(people: 1), slow: nil, at: 2.0).status.extraPerson)
        XCTAssertFalse(a.ingest(fast(people: 1), slow: nil, at: 3.0).status.extraPerson)
    }
    func testPeopleWindowExpires() {
        var a = DeskCameraAggregator()
        _ = a.ingest(fast(people: 3), slow: nil, at: 0)
        XCTAssertEqual(a.ingest(fast(people: 1), slow: nil, at: 2.9).status.people, 3)
        XCTAssertEqual(a.ingest(fast(people: 1), slow: nil, at: 3.6).status.people, 1)
    }

    // MARK: hands
    func testMoreThanTwoHandsFlagsAfterOneSecond() {
        var a = DeskCameraAggregator()
        var f = fast(hands: 3); f.leftHands = 2; f.rightHands = 1
        XCTAssertFalse(a.ingest(f, slow: nil, at: 0).status.extraHands)
        let out = a.ingest(f, slow: nil, at: 1.0)
        XCTAssertTrue(out.status.extraHands)
        XCTAssertEqual(out.status.handCount, 3)
        XCTAssertEqual(out.status.leftHands, 2)
        XCTAssertEqual(out.newTriggers, ["extraHands"])
    }
    func testTwoHandsAreNormal() {
        var a = DeskCameraAggregator()
        for t in stride(from: 0.0, through: 3.0, by: 0.5) { XCTAssertFalse(a.ingest(fast(hands: 2), slow: nil, at: t).status.extraHands) }
    }

    // MARK: text, objects
    func testTextNeedsTwoSlowSamplesTwoSecondsApart() {
        var a = DeskCameraAggregator()
        let text = SlowObservation(textVisible: true)
        XCTAssertFalse(a.ingest(fast(), slow: text, at: 0).status.textVisible)
        XCTAssertFalse(a.ingest(fast(), slow: nil, at: 0.5).status.textVisible)
        let out = a.ingest(fast(), slow: text, at: 2.0)
        XCTAssertTrue(out.status.textVisible)
        XCTAssertEqual(out.newTriggers, ["textVisible"])
        // Stays on between slow samples, goes off once the text is gone and the grace passes.
        XCTAssertTrue(a.ingest(fast(), slow: nil, at: 3.0).status.textVisible)
        XCTAssertFalse(a.ingest(fast(), slow: nil, at: 7.0).status.textVisible)
    }
    func testTextHeuristicIgnoresKeycapsAndKeepsNoCharacters() {
        XCTAssertFalse(DeskHeuristics.textVisible([.init(characters: 1, confidence: 0.9), .init(characters: 1, confidence: 0.9)]))
        XCTAssertFalse(DeskHeuristics.textVisible([.init(characters: 12, confidence: 0.2)]))
        XCTAssertTrue(DeskHeuristics.textVisible([.init(characters: 6, confidence: 0.8), .init(characters: 5, confidence: 0.6)]))
        XCTAssertTrue(DeskHeuristics.textVisible([.init(characters: 25, confidence: 0.9)]))
    }
    func testObjectHintsAllowlistAndConfidence() {
        let hints = DeskHeuristics.hints(from: [("cellphone", 0.31), ("Mobile Phone", 0.2), ("paper", 0.29), ("book", 0.9),
                                                 ("cat", 0.99), ("laptop", 0.9)])
        XCTAssertEqual(hints, ["cellphone", "book"])
        XCTAssertTrue(DeskHeuristics.hints(from: [("keyboard", 0.9)]).isEmpty)
    }
    func testObjectHintsAreDebouncedAndEdgeTriggered() {
        var a = DeskCameraAggregator()
        let paper = SlowObservation(hints: ["paper"])
        XCTAssertTrue(a.ingest(fast(), slow: paper, at: 0).status.objectHints.isEmpty)
        let out = a.ingest(fast(), slow: paper, at: 2.0)
        XCTAssertEqual(out.status.objectHints, ["paper"])
        XCTAssertEqual(out.newTriggers, ["objectHints"])
        XCTAssertTrue(a.ingest(fast(), slow: SlowObservation(hints: ["paper"]), at: 4.0).newTriggers.isEmpty)
        let second = SlowObservation(hints: ["paper", "cellphone"])
        _ = a.ingest(fast(), slow: second, at: 6.0)
        XCTAssertEqual(a.ingest(fast(), slow: second, at: 8.0).newTriggers, ["objectHints"]) // a new hint
    }
    func testBrightRectangleInDeskAreaOnly() {
        // 4x4 grid, upright (row 0 = top). Lower half (desk) has a bright 2x2 block; the rest is mid-gray.
        var samples = [UInt8](repeating: 80, count: 16)
        for (r, c) in [(2, 1), (2, 2), (3, 1), (3, 2)] { samples[r * 4 + c] = 240 }
        let grid = LumaGrid(width: 4, height: 4, samples: samples)
        let desk = CGRect(x: 0.25, y: 0.0, width: 0.5, height: 0.5)
        let top = CGRect(x: 0.25, y: 0.5, width: 0.5, height: 0.5)
        XCTAssertEqual(DeskHeuristics.brightRectangles([desk], grid: grid), 1)
        XCTAssertEqual(DeskHeuristics.brightRectangles([top], grid: grid), 0)
        XCTAssertEqual(DeskHeuristics.brightRectangles([CGRect(x: 0, y: 0, width: 1, height: 0.5)], grid: grid), 0) // too big/dim
    }

    // MARK: obstruction
    func testObstructionMath() {
        let dark = LumaGrid(width: 4, height: 4, samples: [UInt8](repeating: 5, count: 16))
        XCTAssertTrue(DeskHeuristics.isObstructed(mean: dark.stats.mean, variance: dark.stats.variance))
        let flat = LumaGrid(width: 4, height: 4, samples: [UInt8](repeating: 140, count: 16))
        XCTAssertTrue(DeskHeuristics.isObstructed(mean: flat.stats.mean, variance: flat.stats.variance))
        let busy = LumaGrid(width: 4, height: 4, samples: (0..<16).map { UInt8($0 * 14 + 20) })
        XCTAssertFalse(DeskHeuristics.isObstructed(mean: busy.stats.mean, variance: busy.stats.variance))
    }
    func testObstructedIsDebounced() {
        var a = DeskCameraAggregator()
        var covered = FastObservation(); covered.obstructed = true
        XCTAssertFalse(a.ingest(covered, slow: nil, at: 0).status.cameraObstructed)
        XCTAssertFalse(a.ingest(covered, slow: nil, at: 1.0).status.cameraObstructed)
        let out = a.ingest(covered, slow: nil, at: 2.0)
        XCTAssertTrue(out.status.cameraObstructed)
        XCTAssertEqual(out.newTriggers, ["cameraObstructed"])
    }

    // MARK: evidence + send policy
    func testEvidenceRateLimits() {
        var l = EvidenceLimiter()
        XCTAssertTrue(l.allow("extraPerson", at: 100))
        XCTAssertFalse(l.allow("extraPerson", at: 129.9))
        XCTAssertTrue(l.allow("textVisible", at: 101))
        XCTAssertTrue(l.allow("extraPerson", at: 130))
        var m = EvidenceLimiter()
        for i in 0..<EvidenceLimiter.maxPerExam { XCTAssertTrue(m.allow("t\(i)", at: Double(i))) }
        XCTAssertFalse(m.allow("new", at: 1000))
        m.reset()
        XCTAssertTrue(m.allow("new", at: 1001))
    }
    func testChangeSendsSoonerButNotUnderServerGap() {
        let t = Date()
        XCTAssertFalse(DeskCameraPolicy.shouldSend(now: t.addingTimeInterval(1), lastSent: t, changed: true))
        XCTAssertTrue(DeskCameraPolicy.shouldSend(now: t.addingTimeInterval(2.5), lastSent: t, changed: true))
        XCTAssertFalse(DeskCameraPolicy.shouldSend(now: t.addingTimeInterval(3), lastSent: t, changed: false))
        XCTAssertTrue(DeskCameraPolicy.shouldSend(now: t.addingTimeInterval(5), lastSent: t, changed: false))
    }
    func testSlowTierIsTimeBased() {
        XCTAssertTrue(DeskCameraPolicy.slowTierDue(now: 10, lastSlow: nil))
        XCTAssertFalse(DeskCameraPolicy.slowTierDue(now: 11.4, lastSlow: 10))
        XCTAssertTrue(DeskCameraPolicy.slowTierDue(now: 11.95, lastSlow: 10))
    }
    func testEvidenceTriggerMapping() {
        XCTAssertEqual(DeskHeuristics.evidenceTrigger(flag: "extraPerson", hints: []), "extra_person")
        XCTAssertEqual(DeskHeuristics.evidenceTrigger(flag: "cameraObstructed", hints: []), "left_frame")
        XCTAssertEqual(DeskHeuristics.evidenceTrigger(flag: "objectHints", hints: ["paper", "cellphone"]), "phone_detected")
        XCTAssertNil(DeskHeuristics.evidenceTrigger(flag: "objectHints", hints: ["paper"]))
        XCTAssertNil(DeskHeuristics.evidenceTrigger(flag: "extraHands", hints: []))
        XCTAssertNil(DeskHeuristics.evidenceTrigger(flag: "textVisible", hints: []))
    }
}
