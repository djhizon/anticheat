import SwiftUI
import UIKit

@main struct ExamCompanionApp: App {
    @StateObject private var controller = PresenceController()
    var body: some Scene {
        WindowGroup { RootView(controller: controller) }
    }
}

/// Two steps for the student: install the app, scan the QR on the laptop. Everything else is automatic.
struct RootView: View {
    @Environment(\.scenePhase) private var phase
    @ObservedObject var controller: PresenceController

    var body: some View {
        Group {
            switch controller.screen {
            case .scanning: ScannerScreen(controller: controller)
            case .connecting, .connectFailed: ConnectingScreen(controller: controller)
            case .paired: PairedScreen(controller: controller)
            }
        }
        .onAppear { controller.scenePhaseChanged(phase) }
        .modifier(PhaseChange(phase: phase) { controller.scenePhaseChanged($0) })
        // Pairing links tapped in the system Camera app or elsewhere open here.
        .onOpenURL { controller.acceptLink($0.absoluteString) }
    }
}

// MARK: - Step 2: scan

struct ScannerScreen: View {
    @ObservedObject var controller: PresenceController
    @StateObject private var scanner = QRScanner()
    @State private var pastedLink = ""
    @State private var showPaste = false

    var body: some View {
        VStack(spacing: 18) {
            Text("Scan the QR code on your laptop").font(.title2.bold()).multilineTextAlignment(.center)
            Text(controller.status).font(.subheadline).foregroundStyle(.secondary)
                .multilineTextAlignment(.center).accessibilityIdentifier("presence-status")
            camera
            if let hint = controller.scanHint {
                Text(hint).font(.callout).foregroundStyle(.orange).multilineTextAlignment(.center)
                    .accessibilityIdentifier("scan-hint")
            }
            if showPaste || scanner.availability == .unavailable || scanner.availability == .denied {
                pasteField
            } else {
                Button("Paste a pairing link instead") { showPaste = true }.font(.footnote)
            }
            Spacer(minLength: 0)
            Text("This app only tells your laptop that your phone is here. It never sends camera, microphone, or screen data.")
                .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }
        .padding(24)
        .onAppear {
            scanner.onCode = { [weak controller] in controller?.acceptLink($0) }
            if controller.appActive { scanner.start() }
        }
        .onDisappear { scanner.stop() }
        .modifier(ValueChange(value: controller.appActive) { active in active ? scanner.start() : scanner.stop() })
    }

    @ViewBuilder private var camera: some View {
        switch scanner.availability {
        case .running, .starting:
            CameraPreview(session: scanner.session)
                .aspectRatio(1, contentMode: .fit)
                .overlay(RoundedRectangle(cornerRadius: 16).stroke(.white.opacity(0.8), lineWidth: 3).padding(40))
                .clipShape(RoundedRectangle(cornerRadius: 20))
                .accessibilityLabel("QR scanner")
                .accessibilityIdentifier("qr-scanner")
        case .unavailable:
            Label("Camera unavailable — paste link", systemImage: "camera.metering.unknown")
                .font(.headline).frame(maxWidth: .infinity, minHeight: 120)
                .background(RoundedRectangle(cornerRadius: 20).fill(Color(.secondarySystemBackground)))
                .accessibilityIdentifier("camera-unavailable")
        case .denied:
            VStack(spacing: 10) {
                Label("Camera access is off", systemImage: "camera.fill").font(.headline)
                Text("Allow the camera in Settings to scan, or paste the pairing link below.").font(.callout)
                    .multilineTextAlignment(.center)
                Button("Open Settings") {
                    if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                }
            }
            .padding().frame(maxWidth: .infinity, minHeight: 120)
            .background(RoundedRectangle(cornerRadius: 20).fill(Color(.secondarySystemBackground)))
            .accessibilityIdentifier("camera-denied")
        }
    }

    private var pasteField: some View {
        VStack(spacing: 10) {
            TextField("examcompanion://pair?…", text: $pastedLink)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                .textFieldStyle(.roundedBorder)
                .accessibilityIdentifier("pairing-link-field")
            Button("Use pairing link") {
                UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
                controller.acceptLink(pastedLink)
                pastedLink = ""
            }
            .buttonStyle(.borderedProminent)
            .disabled(pastedLink.trimmingCharacters(in: .whitespaces).isEmpty)
        }
    }
}

// MARK: - Connecting

struct ConnectingScreen: View {
    @ObservedObject var controller: PresenceController

    var body: some View {
        VStack(spacing: 22) {
            Spacer()
            if controller.screen == .connecting {
                ProgressView().controlSize(.large)
            } else {
                Image(systemName: "wifi.exclamationmark").font(.system(size: 56)).foregroundStyle(.orange)
            }
            Text(controller.status).font(.title3.weight(.semibold)).multilineTextAlignment(.center)
                .accessibilityIdentifier("presence-status")
            if controller.screen == .connectFailed {
                Button("Try again") { controller.retry() }.buttonStyle(.borderedProminent).controlSize(.large)
                Button("Scan again") { controller.scanAgain() }
            }
            Spacer()
        }
        .padding(28)
    }
}

// MARK: - Paired

struct PairedScreen: View {
    @ObservedObject var controller: PresenceController
    @State private var confirmUnpair = false

    private var symbol: (name: String, colour: Color) {
        switch controller.link {
        case .connected: return ("checkmark.circle.fill", .green)
        case .reconnecting: return ("arrow.triangle.2.circlepath.circle.fill", .orange)
        case .laptopNotResponding: return ("exclamationmark.triangle.fill", .red)
        }
    }

    var body: some View {
        VStack(spacing: 20) {
            Spacer()
            ZStack {
                PingPulse(colour: symbol.colour, active: controller.link == .connected,
                          beat: controller.lastAcknowledged)
                Image(systemName: symbol.name).font(.system(size: 88)).foregroundStyle(symbol.colour)
            }
            .frame(width: 220, height: 220)
            .accessibilityHidden(true)
            Text("Paired with your laptop").font(.largeTitle.bold()).multilineTextAlignment(.center)
            Text("Keep this app open and put the phone face-down on the desk.")
                .font(.title3).multilineTextAlignment(.center)
            Text(controller.status).font(.headline).foregroundStyle(symbol.colour)
                .multilineTextAlignment(.center).accessibilityIdentifier("presence-status")
            if let date = controller.lastAcknowledged {
                Text("Last check: \(date.formatted(date: .omitted, time: .standard))")
                    .font(.caption).foregroundStyle(.secondary)
            }
            #if DEBUG
            if MockLaptop.enabled { MockLaptopLog() }
            #endif
            Spacer()
            Text("Leaving this app or locking the phone is noted for your instructor. Keep it open until you submit.")
                .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
            Button("Unpair", role: .destructive) { confirmUnpair = true }.font(.footnote)
                .confirmationDialog("Unpair from your laptop?", isPresented: $confirmUnpair, titleVisibility: .visible) {
                    Button("Unpair", role: .destructive) { controller.scanAgain() }
                } message: {
                    Text("Your laptop will pause answering until you scan a new QR code.")
                }
        }
        .padding(28)
    }
}

/// Radar-style rings that ripple out while the phone is pinging the laptop, with a brighter burst
/// on every acknowledged ping. Static under Reduce Motion.
struct PingPulse: View {
    let colour: Color
    let active: Bool
    let beat: Date?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var ripple = false
    @State private var burst = false

    var body: some View {
        ZStack {
            ForEach(0..<3, id: \.self) { ring in
                Circle()
                    .stroke(colour.opacity(0.5), lineWidth: 3)
                    .scaleEffect(ripple ? 2.2 : 0.6)
                    .opacity(ripple ? 0 : 0.9)
                    .animation(
                        reduceMotion || !active
                            ? nil
                            : .easeOut(duration: 2.4).repeatForever(autoreverses: false)
                                .delay(Double(ring) * 0.8),
                        value: ripple)
            }
            Circle()
                .fill(colour.opacity(burst ? 0.35 : 0.12))
                .scaleEffect(burst ? 1.25 : 1.0)
                .animation(reduceMotion ? nil : .easeOut(duration: 0.45), value: burst)
        }
        .frame(width: 120, height: 120)
        .opacity(active ? 1 : 0.35)
        .onAppear { ripple = active && !reduceMotion }
        .onChange(of: active) { now in ripple = now && !reduceMotion }
        .onChange(of: beat) { _ in
            guard !reduceMotion else { return }
            burst = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) { burst = false }
        }
    }
}
