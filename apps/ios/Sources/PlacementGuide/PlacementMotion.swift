import CoreMotion
import SwiftUI
import UIKit

/// DEBUG helpers. Launch with `-placementGuideDebug` to open the guide with a placeholder preview
/// (the Simulator has no camera and no motion sensors). Always false in Release.
enum PlacementDebug {
    static var enabled: Bool {
        #if DEBUG
        return ProcessInfo.processInfo.arguments.contains("-placementGuideDebug")
        #else
        return false
        #endif
    }
}

/// Orientation, tilt and steadiness of the phone. Uses CoreMotion gravity when available and falls
/// back to UIDevice orientation (Simulator). Nothing here leaves the phone.
@MainActor
final class PlacementMotion: ObservableObject {
    @Published private(set) var isLandscape = false
    /// Degrees the screen plane is away from vertical. nil when there is no motion sensor.
    @Published private(set) var tiltDegrees: Double?
    /// Degrees the long edge is away from level (landscape).
    @Published private(set) var rollDegrees: Double?
    @Published private(set) var isSteady = false
    private(set) var gravity: (x: Double, y: Double, z: Double)?

    private let manager = CMMotionManager()
    private var steady = SteadyTracker()
    private var observer: NSObjectProtocol?
    private var running = false

    /// For Vision: the last known landscape side (defaults to landscapeLeft).
    private(set) var deviceOrientation: UIDeviceOrientation = .landscapeLeft

    func start() {
        guard !running else { return }
        running = true
        UIDevice.current.beginGeneratingDeviceOrientationNotifications()
        applyDeviceOrientation()
        observer = NotificationCenter.default.addObserver(forName: UIDevice.orientationDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.applyDeviceOrientation() }
        }
        guard manager.isDeviceMotionAvailable else { return }
        manager.deviceMotionUpdateInterval = 0.1
        manager.startDeviceMotionUpdates(to: .main) { [weak self] motion, _ in
            guard let motion else { return }
            Task { @MainActor in self?.apply(motion) }
        }
    }

    func stop() {
        guard running else { return }
        running = false
        manager.stopDeviceMotionUpdates()
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = nil
        UIDevice.current.endGeneratingDeviceOrientationNotifications()
        steady.reset()
        isSteady = false
    }

    private func applyDeviceOrientation() {
        let o = UIDevice.current.orientation
        if o.isLandscape { deviceOrientation = o }
        // Gravity is authoritative when we have it.
        guard gravity == nil else { return }
        if o.isLandscape { isLandscape = true } else if o.isPortrait { isLandscape = false }
    }

    private func apply(_ m: CMDeviceMotion) {
        let g = (x: m.gravity.x, y: m.gravity.y, z: m.gravity.z)
        gravity = g
        if let land = PlacementPolicy.isLandscape(gravityX: g.x, gravityY: g.y), land != isLandscape { isLandscape = land }
        let tilt = PlacementPolicy.tiltDegrees(gravityZ: g.z)
        if tiltDegrees == nil || abs((tiltDegrees ?? 0) - tilt) > 0.5 { tiltDegrees = tilt }
        let roll = PlacementPolicy.rollDegrees(gravityX: g.x, gravityY: g.y)
        if rollDegrees == nil || abs((rollDegrees ?? 0) - roll) > 0.5 { rollDegrees = roll }
        let rot = (m.rotationRate.x * m.rotationRate.x + m.rotationRate.y * m.rotationRate.y + m.rotationRate.z * m.rotationRate.z).squareRoot()
        let acc = (m.userAcceleration.x * m.userAcceleration.x + m.userAcceleration.y * m.userAcceleration.y + m.userAcceleration.z * m.userAcceleration.z).squareRoot()
        steady.add(time: m.timestamp, magnitude: rot + 2 * acc)
        let now = steady.isSteady(at: m.timestamp)
        if now != isSteady { isSteady = now }
    }
}
