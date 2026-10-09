import SwiftUI

/// Wiring point for the existing app. A `placement_changed` flag can be sent by assigning this closure
/// (called once each time the phone is judged moved / fallen after setup). Not wired to the laptop yet.
enum PlacementGuideHooks {
    static var onPlacementChanged: (() -> Void)?
}

/// Owns the sensors and decides when the setup / "put it back" screens show.
@MainActor
final class PlacementFlow: ObservableObject {
    @Published var showSetup = false
    @Published private(set) var showReposition = false
    let motion = PlacementMotion()
    let analyzer = PlacementAnalyzer()

    private var reference: (x: Double, y: Double, z: Double)?
    private var watching = false
    private var timer: Timer?
    private var badSince: Date?
    private var goodSince: Date?

    func beginSetup() {
        stopWatching()
        showReposition = false
        showSetup = true
        motion.start()
    }

    func finishSetup() {
        showSetup = false
        reference = motion.gravity
        watching = true
        badSince = nil; goodSince = nil
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.watch() }
        }
    }

    func end() {
        stopWatching()
        showSetup = false
        showReposition = false
        analyzer.detach()
        motion.stop()
    }

    private func stopWatching() { watching = false; timer?.invalidate(); timer = nil }

    private func inPosition(tiltLimit: Double, driftLimit: Double) -> Bool {
        if !motion.isLandscape { return false }
        if let t = motion.tiltDegrees, t > tiltLimit { return false }
        if let ref = reference, let g = motion.gravity, PlacementPolicy.angleBetween(ref, g) > driftLimit { return false }
        return true
    }

    private func watch() {
        guard watching else { return }
        let now = Date()
        if showReposition {
            if inPosition(tiltLimit: PlacementPolicy.maxTiltDegrees, driftLimit: 10) {
                goodSince = goodSince ?? now
                if now.timeIntervalSince(goodSince!) >= 1.5 { showReposition = false; goodSince = nil; badSince = nil }
            } else { goodSince = nil }
        } else if !inPosition(tiltLimit: PlacementPolicy.driftTiltDegrees, driftLimit: 20) {
            badSince = badSince ?? now
            if now.timeIntervalSince(badSince!) >= 1.5 {
                showReposition = true; badSince = nil; goodSince = nil
                PlacementGuideHooks.onPlacementChanged?()
            }
        } else { badSince = nil }
    }
}

struct PlacementGuideHost: ViewModifier {
    @ObservedObject var controller: PresenceController
    @ObservedObject var camera: DeskCameraController
    @StateObject private var flow = PlacementFlow()

    func body(content: Content) -> some View {
        content
            .onAppear { if PlacementDebug.enabled { flow.beginSetup() } }
            .onChange(of: controller.deskCameraWanted) { wanted in
                if wanted { flow.beginSetup() } else { flow.end() }
            }
            .fullScreenCover(isPresented: $flow.showSetup) {
                PlacementGuideView(motion: flow.motion, analyzer: flow.analyzer, session: camera.session,
                                   cameraRunning: camera.running, cameraMessage: camera.message,
                                   debug: PlacementDebug.enabled,
                                   onFinish: { flow.finishSetup() },
                                   onCancel: { controller.setDeskCamera(false); flow.end() })
            }
            .overlay { if flow.showReposition { PlacementRepositionOverlay().transition(.opacity) } }
            .animation(.easeInOut(duration: 0.25), value: flow.showReposition)
    }
}

extension View {
    /// Shows the guided placement setup when the desk camera is switched on.
    func placementGuide(controller: PresenceController) -> some View {
        modifier(PlacementGuideHost(controller: controller, camera: controller.deskCamera))
    }
}
