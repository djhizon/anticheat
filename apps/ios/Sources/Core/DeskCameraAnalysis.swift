import CoreGraphics
import Foundation

// Pure, camera-free logic for the desk-camera heuristics. Everything here takes plain numbers and
// returns flags, so it is unit-tested without a camera, Vision, or a simulator frame.

/// Low-resolution luminance grid (0...255, row-major, row 0 = TOP of the upright image).
struct LumaGrid: Equatable {
    let width: Int
    let height: Int
    let samples: [UInt8]

    /// Mean and variance of luminance scaled to 0...1.
    var stats: (mean: Double, variance: Double) {
        guard !samples.isEmpty else { return (0, 0) }
        let values = samples.map { Double($0) / 255 }
        let mean = values.reduce(0, +) / Double(values.count)
        let variance = values.reduce(0) { $0 + ($1 - mean) * ($1 - mean) } / Double(values.count)
        return (mean, variance)
    }

    /// Mean luminance (0...1) inside a Vision-style normalized rect (origin bottom-left).
    func mean(in rect: CGRect) -> Double? {
        guard width > 0, height > 0, samples.count == width * height else { return nil }
        let x0 = max(0, Int((rect.minX * Double(width)).rounded(.down)))
        let x1 = min(width, Int((rect.maxX * Double(width)).rounded(.up)))
        let y0 = max(0, Int(((1 - rect.maxY) * Double(height)).rounded(.down)))
        let y1 = min(height, Int(((1 - rect.minY) * Double(height)).rounded(.up)))
        guard x1 > x0, y1 > y0 else { return nil }
        var sum = 0.0, count = 0.0
        for y in y0..<y1 { for x in x0..<x1 { sum += Double(samples[y * width + x]) / 255; count += 1 } }
        return sum / count
    }
}

enum DeskHeuristics {
    /// Region (Vision coordinates, origin bottom-left) treated as "the desk": lower part of the frame.
    static let deskRegion = CGRect(x: 0, y: 0, width: 1, height: 0.55)

    /// Camera covered or very dark (low mean) or featureless (almost no variance, e.g. a hand or
    /// cloth over the lens). Thresholds are on the 0...1 luminance scale.
    static func isObstructed(mean: Double, variance: Double) -> Bool {
        mean < 0.05 || variance < 0.0004
    }

    /// Count of bright rectangular objects (paper, a lit phone screen) lying in the desk region.
    static func brightRectangles(_ rects: [CGRect], grid: LumaGrid) -> Int {
        let overall = grid.stats.mean
        return rects.filter { rect in
            let area = rect.width * rect.height
            guard area >= 0.01, area <= 0.4, rect.midY < deskRegion.maxY,
                  let inside = grid.mean(in: rect) else { return false }
            return inside >= 0.55 && inside >= overall + 0.12
        }.count
    }

    /// One recognised text line: only its length and confidence are kept, never the characters.
    struct TextBlock: Equatable {
        let characters: Int
        let confidence: Float
    }

    /// Readable text in the desk region. Single key-cap letters are ignored by the length filter.
    static func textVisible(_ blocks: [TextBlock]) -> Bool {
        let good = blocks.filter { $0.characters >= 4 && $0.confidence >= 0.5 }
        return good.count >= 2 || good.reduce(0) { $0 + $1.characters } >= 20
    }

    /// Vision classification identifiers mapped onto a tiny allowlist. Names only, confidence >= 0.3.
    static let hintMap: [String: String] = [
        "cellphone": "cellphone", "mobile_phone": "cellphone", "smartphone": "cellphone",
        "paper": "paper", "document": "paper",
        "book": "book", "textbook": "book", "notebook": "book"
    ]
    /// Everything the phone may ever put in `objectHints` (the server enforces the same list).
    static let allowedHints: Set<String> = Set(hintMap.values).union(["bright_rectangle"])

    static func hints(from labels: [(identifier: String, confidence: Float)]) -> Set<String> {
        var out = Set<String>()
        for label in labels where label.confidence >= 0.3 {
            let key = label.identifier.lowercased().replacingOccurrences(of: " ", with: "_")
            if let hint = hintMap[key] { out.insert(hint) }
        }
        return out
    }
}

extension DeskHeuristics {
    /// Triggers the server accepts for evidence stills. extraHands, textVisible and non-phone object
    /// hints have no server trigger yet, so they travel as flags only (no snapshot).
    static func evidenceTrigger(flag: String, hints: [String]) -> String? {
        switch flag {
        case "extraPerson": return "extra_person"
        case "cameraObstructed": return "left_frame"
        case "objectHints": return hints.contains("cellphone") ? "phone_detected" : nil
        default: return nil
        }
    }
}

/// Fast tier (people, faces, hands, luminance): every frame that is analysed.
struct FastObservation: Equatable {
    var personBoxes: [CGRect] = []
    var faces = 0
    var handPoints: [CGPoint] = []
    var handCount = 0
    var leftHands = 0
    var rightHands = 0
    var obstructed = false
}

/// Slow tier (text, rectangles, classification): analysed less often because it is costlier.
struct SlowObservation: Equatable {
    var textVisible = false
    var brightRectangles = 0
    var hints = Set<String>()
}

/// A condition that must hold for `hold` seconds before it counts, and survives gaps up to `grace`.
struct Hold {
    let hold: TimeInterval
    let grace: TimeInterval
    private var since: TimeInterval?
    private var lastTrue: TimeInterval?
    init(hold: TimeInterval, grace: TimeInterval) { self.hold = hold; self.grace = grace }

    mutating func observe(_ condition: Bool, at t: TimeInterval) {
        if let last = lastTrue, t < last || t - last > grace { since = nil; lastTrue = nil }
        guard condition else { return }
        if since == nil { since = t }
        lastTrue = t
    }

    func active(at t: TimeInterval) -> Bool {
        guard let since, let lastTrue else { return false }
        return lastTrue - since >= hold && t - lastTrue <= grace
    }
}

struct DeskCameraOutput: Equatable {
    let status: DeskCameraStatus
    /// Flags that became active on this observation (edge only): the evidence-snapshot triggers.
    let newTriggers: [String]
}

/// Debounces and windows raw observations into the flags that leave the phone.
struct DeskCameraAggregator {
    static let window: TimeInterval = 3
    private var samples: [(t: TimeInterval, people: Int, hands: Int, left: Int, right: Int)] = []
    private var extraPerson = Hold(hold: 1.5, grace: 1.0)
    private var extraHands = Hold(hold: 1.0, grace: 1.0)
    private var obstructed = Hold(hold: 2.0, grace: 1.0)
    private var text = Hold(hold: 2.0, grace: 4.0)
    private var hintHolds: [String: Hold] = [:]
    private var previous = Set<String>()
    private var previousHints = Set<String>()

    mutating func ingest(_ fast: FastObservation, slow: SlowObservation?, at t: TimeInterval) -> DeskCameraOutput {
        let count = max(fast.personBoxes.count, fast.faces)
        samples.append((t, count, fast.handCount, fast.leftHands, fast.rightHands))
        samples.removeAll { t - $0.t > Self.window || $0.t > t }
        let peakPeople = samples.map(\.people).max() ?? 0
        let peakHands = samples.max(by: { $0.hands < $1.hands })

        extraPerson.observe(count >= 2, at: t)
        extraHands.observe(fast.handCount > 2, at: t)
        obstructed.observe(fast.obstructed, at: t)
        if let slow {
            text.observe(slow.textVisible, at: t)
            var present = slow.hints
            if slow.brightRectangles > 0 { present.insert("bright_rectangle") }
            for hint in DeskHeuristics.allowedHints {
                var hold = hintHolds[hint] ?? Hold(hold: 2.0, grace: 4.0)
                hold.observe(present.contains(hint), at: t)
                hintHolds[hint] = hold
            }
        }
        let hints = Set(hintHolds.filter { $0.value.active(at: t) }.keys)

        var active = Set<String>()
        if extraPerson.active(at: t) { active.insert("extraPerson") }
        if extraHands.active(at: t) { active.insert("extraHands") }
        if obstructed.active(at: t) { active.insert("cameraObstructed") }
        if text.active(at: t) { active.insert("textVisible") }
        if !hints.isEmpty { active.insert("objectHints") }

        var triggers = active.subtracting(previous)
        if !hints.subtracting(previousHints).isEmpty { triggers.insert("objectHints") }
        previous = active
        previousHints = hints

        let status = DeskCameraStatus(
            people: peakPeople,
            handsVisible: DeskCameraPolicy.handsNearKeyboard(handPoints: fast.handPoints),
            framingOk: DeskCameraPolicy.framingOk(personBoxes: fast.personBoxes),
            extraPerson: active.contains("extraPerson"), extraHands: active.contains("extraHands"),
            handCount: peakHands?.hands ?? 0, leftHands: peakHands?.left ?? 0, rightHands: peakHands?.right ?? 0,
            textVisible: active.contains("textVisible"), objectHints: hints.sorted(),
            cameraObstructed: active.contains("cameraObstructed"))
        return DeskCameraOutput(status: status, newTriggers: triggers.sorted())
    }
}

/// Evidence snapshots: at most one per trigger type per 30 s and 20 per exam.
struct EvidenceLimiter {
    static let perTriggerInterval: TimeInterval = 30
    static let maxPerExam = 20
    private var last: [String: TimeInterval] = [:]
    private(set) var total = 0

    mutating func allow(_ trigger: String, at t: TimeInterval) -> Bool {
        guard total < Self.maxPerExam else { return false }
        if let previous = last[trigger], t >= previous, t - previous < Self.perTriggerInterval { return false }
        last[trigger] = t
        total += 1
        return true
    }
    mutating func reset() { last = [:]; total = 0 }
}
