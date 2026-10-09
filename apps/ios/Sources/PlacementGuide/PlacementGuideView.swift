import AVFoundation
import SwiftUI
import UIKit

/// The guided "place your phone" setup: rotate -> position -> live preview with alignment helpers.
/// Everything is computed on this phone; no images are stored or sent.
struct PlacementGuideView: View {
    enum Step: Int { case rotate = 1, position, preview }

    @ObservedObject var motion: PlacementMotion
    @ObservedObject var analyzer: PlacementAnalyzer
    let session: AVCaptureSession
    let cameraRunning: Bool
    let cameraMessage: String
    let debug: Bool
    let onFinish: () -> Void
    let onCancel: () -> Void

    @Environment(\.verticalSizeClass) private var vSize
    @State private var step: Step = .rotate
    @State private var simulateGood = false
    @State private var hold = HoldTimer()
    @State private var progress = 0.0
    @State private var done = false

    private let tick = Timer.publish(every: 0.25, on: .main, in: .common).autoconnect()

    // MARK: Signals
    private var inFrame: Bool { debug ? simulateGood : analyzer.personInFrame }
    private var handsOk: Bool { debug ? simulateGood : analyzer.handsVisible }
    private var lightOk: Bool { debug ? simulateGood : analyzer.lightingOk }
    private var steadyOk: Bool { debug ? simulateGood : motion.isSteady }
    private var allGreen: Bool {
        inFrame && handsOk && lightOk && steadyOk && PlacementPolicy.tiltOk(motion.tiltDegrees) && motion.isLandscape
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                Text("Step \(step.rawValue) of 3").font(.footnote.bold()).foregroundStyle(.secondary)
                    .accessibilityIdentifier("placement-step")
                switch step {
                case .rotate: rotateStep
                case .position: positionStep
                case .preview: previewStep
                }
                Button("Cancel setup", role: .cancel) { onCancel() }
                    .font(.footnote).accessibilityIdentifier("placement-cancel")
            }
            .padding(24)
            .frame(maxWidth: .infinity)
        }
        .background(Color(.systemBackground).ignoresSafeArea())
        .onAppear { considerAdvance(); syncAnalyzer() }
        .onDisappear { analyzer.detach() }
        .onChange(of: motion.isLandscape) { _ in considerAdvance() }
        .onChange(of: step) { new in
            syncAnalyzer()
            UIAccessibility.post(notification: .announcement, argument: title(for: new))
        }
        .onChange(of: cameraRunning) { _ in syncAnalyzer() }
        .onReceive(tick) { _ in evaluate() }
    }

    // MARK: Steps
    private var rotateStep: some View {
        VStack(spacing: 16) {
            Text("Turn your phone sideways").font(.title2.bold()).multilineTextAlignment(.center)
                .accessibilityAddTraits(.isHeader)
            RotatePhoneIllustration()
            Text(motion.isLandscape ? "Great, it's sideways." : "Rotate the phone to landscape. We'll continue automatically.")
                .multilineTextAlignment(.center)
            nextButton { go(.position) }
        }
    }

    private var positionStep: some View {
        let layout = vSize == .compact ? AnyLayout(HStackLayout(spacing: 20)) : AnyLayout(VStackLayout(spacing: 16))
        return VStack(spacing: 16) {
            Text("Place the phone beside your laptop").font(.title2.bold()).multilineTextAlignment(.center)
                .accessibilityAddTraits(.isHeader)
            layout {
                DeskDiagram().frame(maxWidth: 280)
                VStack(alignment: .leading, spacing: 10) {
                    Text("Rear camera facing you and your keyboard.").font(.headline)
                    Text("Put the phone about 1 m (arm's length) to your side, at a 45° angle, slightly above desk height. Prop it on books or a stand.")
                }
            }
            nextButton { go(.preview) }
        }
    }

    private var previewStep: some View {
        let layout = vSize == .compact ? AnyLayout(HStackLayout(alignment: .top, spacing: 20)) : AnyLayout(VStackLayout(spacing: 16))
        return VStack(spacing: 16) {
            Text("Check the view").font(.title2.bold()).accessibilityAddTraits(.isHeader)
            if done {
                VStack(spacing: 10) {
                    Image(systemName: "checkmark.circle.fill").font(.system(size: 64)).foregroundStyle(.green)
                    Text("Looks good — keep the phone here").font(.title.bold()).multilineTextAlignment(.center)
                        .accessibilityIdentifier("placement-success")
                }
                .padding(.vertical, 30)
                .accessibilityElement(children: .combine)
            } else {
                layout {
                    previewBox
                    VStack(alignment: .leading, spacing: 12) {
                        TiltLevel(tilt: motion.tiltDegrees, roll: motion.rollDegrees).frame(maxWidth: .infinity)
                        if !motion.isLandscape {
                            Label("Turn the phone sideways", systemImage: "rotate.right").font(.callout.bold()).foregroundStyle(.orange)
                        }
                        checklistRow("You are in frame", inFrame, id: "tick-frame")
                        checklistRow("Your hands and keyboard are visible", handsOk, id: "tick-hands")
                        checklistRow("Lighting OK", lightOk, id: "tick-light")
                        checklistRow("Phone is steady", steadyOk, id: "tick-steady")
                        ProgressView(value: progress).tint(.green)
                            .accessibilityLabel("Hold steady")
                            .accessibilityValue("\(Int(progress * 100)) percent")
                        #if DEBUG
                        if debug {
                            Toggle("Simulate good framing", isOn: $simulateGood).font(.caption)
                                .accessibilityIdentifier("placement-simulate")
                        }
                        #endif
                    }
                }
                Text("Keep everything green for 3 seconds.").font(.footnote).foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder private var previewBox: some View {
        ZStack {
            if debug {
                LinearGradient(colors: [.gray.opacity(0.5), .gray.opacity(0.25)], startPoint: .top, endPoint: .bottom)
                VStack { Image(systemName: "camera.metering.unknown").font(.largeTitle); Text("Preview placeholder (no camera)").font(.caption) }
                    .foregroundStyle(.secondary)
            } else if cameraRunning {
                PlacementPreview(session: session)
            } else {
                VStack(spacing: 8) { ProgressView(); Text(cameraMessage).font(.caption).multilineTextAlignment(.center).padding(.horizontal) }
            }
            // Keep the keyboard inside the dashed box, screen above it.
            RoundedRectangle(cornerRadius: 8).stroke(.green.opacity(0.8), style: StrokeStyle(lineWidth: 2, dash: [6]))
                .padding(.horizontal, 24).padding(.top, 70).padding(.bottom, 14)
                .accessibilityHidden(true)
        }
        .frame(maxWidth: .infinity).frame(height: vSize == .compact ? 220 : 240)
        .background(Color.black.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .accessibilityLabel("Live camera preview. Keep your keyboard inside the dashed box.")
        .accessibilityIdentifier("placement-preview")
    }

    private func checklistRow(_ text: String, _ ok: Bool, id: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: ok ? "checkmark.circle.fill" : "circle").foregroundStyle(ok ? .green : .secondary)
            Text(text).font(.callout)
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(text): \(ok ? "done" : "not yet")")
        .accessibilityIdentifier(id)
    }

    private func nextButton(_ action: @escaping () -> Void) -> some View {
        Button("Next", action: action).buttonStyle(.borderedProminent).accessibilityIdentifier("placement-next")
    }

    // MARK: Logic
    private func title(for s: Step) -> String {
        switch s {
        case .rotate: return "Turn your phone sideways"
        case .position: return "Place the phone beside your laptop"
        case .preview: return "Check the view"
        }
    }

    private func go(_ s: Step) { withAnimation { step = s } }

    private func considerAdvance() {
        guard step == .rotate, motion.isLandscape else { return }
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 900_000_000)
            if step == .rotate && motion.isLandscape { go(.position) }
        }
    }

    private func syncAnalyzer() {
        if step == .preview && cameraRunning && !debug { analyzer.attach(to: session) } else { analyzer.detach() }
    }

    private func evaluate() {
        guard step == .preview, !done else { return }
        analyzer.setDeviceOrientation(motion.deviceOrientation)
        progress = hold.update(ok: allGreen, at: Date.timeIntervalSinceReferenceDate)
        if progress >= 1 {
            done = true
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            UIAccessibility.post(notification: .announcement, argument: "Looks good. Keep the phone here.")
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 1_800_000_000)
                onFinish()
            }
        }
    }
}

/// Gentle overlay shown if the phone is moved or falls over after setup.
struct PlacementRepositionOverlay: View {
    var body: some View {
        ZStack {
            Color.black.opacity(0.78).ignoresSafeArea()
            VStack(spacing: 14) {
                Text("Put the phone back in position").font(.title2.bold()).multilineTextAlignment(.center)
                    .accessibilityAddTraits(.isHeader).accessibilityIdentifier("placement-reposition")
                DeskDiagram().frame(maxWidth: 220)
                Text("Landscape, beside your laptop, camera facing you and your keyboard.").font(.callout).multilineTextAlignment(.center)
            }
            .foregroundStyle(.white)
            .padding(24)
        }
        .onAppear { UIAccessibility.post(notification: .announcement, argument: "Put the phone back in position") }
    }
}
