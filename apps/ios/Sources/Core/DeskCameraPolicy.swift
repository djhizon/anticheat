import CoreGraphics
import Foundation

/// Flags-only summary of one on-device desk-camera analysis. Never contains pixels.
struct DeskCameraStatus: Equatable {
    let people: Int
    let handsVisible: Bool
    let framingOk: Bool
}

enum DeskCameraPolicy {
    /// Vision analysis cadence and the server-bound send cadence.
    static let analysisInterval: TimeInterval = 2
    static let sendInterval: TimeInterval = 5

    /// Normalized (0...1, origin bottom-left, as Vision reports) region where a keyboard is expected:
    /// the lower-middle of the frame when the phone is held upright to the side of the desk.
    static let keyboardRegion = CGRect(x: 0.1, y: 0.0, width: 0.8, height: 0.55)

    /// Framing is acceptable when at least one person is clearly in view: the largest box covers a
    /// meaningful part of the frame but is not so large that it is cropped by the edges.
    static func framingOk(personBoxes: [CGRect]) -> Bool {
        guard let largest = personBoxes.max(by: { $0.width * $0.height < $1.width * $1.height }) else { return false }
        let area = largest.width * largest.height
        return area >= 0.08 && area <= 0.92
    }

    /// True when any hand landmark (normalized points) falls inside the keyboard region.
    static func handsNearKeyboard(handPoints: [CGPoint]) -> Bool {
        handPoints.contains { keyboardRegion.contains($0) }
    }

    static func status(personBoxes: [CGRect], handPoints: [CGPoint]) -> DeskCameraStatus {
        DeskCameraStatus(people: personBoxes.count,
                         handsVisible: handsNearKeyboard(handPoints: handPoints),
                         framingOk: framingOk(personBoxes: personBoxes))
    }

    /// At most one send per `sendInterval`; the periodic send doubles as a keep-alive so the
    /// laptop can show "on" and treat silence as "off".
    static func shouldSend(now: Date, lastSent: Date?) -> Bool {
        guard let lastSent else { return true }
        let elapsed = now.timeIntervalSince(lastSent)
        return elapsed < 0 || elapsed >= sendInterval
    }
}
