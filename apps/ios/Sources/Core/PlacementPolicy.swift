import CoreGraphics
import Foundation

/// Pure placement-guide rules (no UIKit / CoreMotion) so they can be unit-tested with `swift test`.
enum PlacementPolicy {
    /// The phone should stand roughly upright: its screen plane within this angle of vertical.
    static let maxTiltDegrees = 15.0
    /// Wider band used after setup so a small nudge does not nag the student (hysteresis).
    static let driftTiltDegrees = 25.0
    /// Everything must be green for this long before setup completes.
    static let holdSeconds = 3.0
    /// Mean luma (0...1) that is neither too dark nor blown out.
    static let lumaRange: ClosedRange<Double> = 0.18...0.88

    /// Angle of the screen plane from vertical, from the gravity z component (0 = upright, 90 = flat).
    static func tiltDegrees(gravityZ: Double) -> Double {
        asin(min(1, abs(gravityZ))) * 180 / .pi
    }

    /// Landscape roll offset (0 = long edge level) from gravity x/y.
    static func rollDegrees(gravityX: Double, gravityY: Double) -> Double {
        atan2(gravityY, abs(gravityX)) * 180 / .pi
    }

    /// nil when the phone is lying flat (orientation is not meaningful).
    static func isLandscape(gravityX: Double, gravityY: Double) -> Bool? {
        let ax = abs(gravityX), ay = abs(gravityY)
        guard max(ax, ay) > 0.5 else { return nil }
        return ax > ay
    }

    static func tiltOk(_ tilt: Double?) -> Bool { tilt.map { $0 <= maxTiltDegrees } ?? true }

    static func lightingOk(meanLuma: Double) -> Bool { lumaRange.contains(meanLuma) }

    /// Vision points are normalised with the origin bottom-left, so the lower half is y < 0.5.
    static func handsInLowerHalf(_ points: [CGPoint]) -> Bool { points.contains { $0.y < 0.5 } }

    /// Angle in degrees between two gravity vectors.
    static func angleBetween(_ a: (x: Double, y: Double, z: Double), _ b: (x: Double, y: Double, z: Double)) -> Double {
        let dot = a.x * b.x + a.y * b.y + a.z * b.z
        let na = (a.x * a.x + a.y * a.y + a.z * a.z).squareRoot()
        let nb = (b.x * b.x + b.y * b.y + b.z * b.z).squareRoot()
        guard na > 0, nb > 0 else { return 0 }
        return acos(max(-1, min(1, dot / (na * nb)))) * 180 / .pi
    }
}

/// "Phone is steady": motion magnitude stayed low, with low variance, for a whole window.
struct SteadyTracker {
    var window: TimeInterval = 3
    var maxMagnitude = 0.35
    var maxVariance = 0.01
    private var samples: [(t: TimeInterval, m: Double)] = []
    private var startedAt: TimeInterval?

    mutating func add(time: TimeInterval, magnitude: Double) {
        if startedAt == nil { startedAt = time }
        samples.append((time, magnitude))
        samples.removeAll { $0.t < time - window }
    }

    func isSteady(at now: TimeInterval) -> Bool {
        guard let start = startedAt, now - start >= window - 0.2, samples.count >= 3 else { return false }
        if samples.contains(where: { $0.m > maxMagnitude }) { return false }
        let mean = samples.reduce(0) { $0 + $1.m } / Double(samples.count)
        let variance = samples.reduce(0) { $0 + ($1.m - mean) * ($1.m - mean) } / Double(samples.count)
        return variance <= maxVariance
    }

    mutating func reset() { samples.removeAll(); startedAt = nil }
}

/// Counts continuous "all OK" time. Any red tick resets it.
struct HoldTimer {
    var required: TimeInterval = PlacementPolicy.holdSeconds
    private var since: TimeInterval?

    /// Progress 0...1; 1 means the hold is complete.
    mutating func update(ok: Bool, at now: TimeInterval) -> Double {
        guard ok else { since = nil; return 0 }
        if since == nil { since = now }
        return min(1, (now - since!) / required)
    }

    mutating func reset() { since = nil }
}
