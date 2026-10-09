import SwiftUI

@main struct ExamCompanionApp: App {
    @StateObject private var controller = PresenceController()
    var body: some Scene {
        WindowGroup { CompanionView(controller: controller).placementGuide(controller: controller) }
    }
}

struct CompanionView: View {
    @Environment(\.scenePhase) private var phase
    @ObservedObject var controller: PresenceController
    @State private var pastedLink = ""
    @State private var consent = false
    @State private var insecureDemo = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    Image(systemName: controller.connected ? "checkmark.shield.fill" : "iphone")
                        .font(.system(size: 58)).foregroundStyle(controller.connected ? .green : .blue)
                    Text("Stay here during your exam").font(.largeTitle.bold())
                    Text(controller.status).font(.headline).accessibilityIdentifier("presence-status")
                    #if DEBUG
                    if MockLaptop.enabled { MockLaptopLog() }
                    #endif
                    Text("Pings are sent only while this app is active. Going Home, locking, or closing it stops pings. Your laptop pauses answering after 8 seconds without a fresh ping. Network interruptions have the same effect; they are not proof of cheating.")
                    if let date = controller.lastAcknowledged {
                        Text("Last acknowledged: \(date.formatted(date: .omitted, time: .standard))").font(.caption)
                    }
                    if let pairing = controller.pending {
                        Text("Laptop: \(pairing.origin.absoluteString)").font(.callout.monospaced()).textSelection(.enabled)
                        Toggle("I agree to foreground connection checks. No phone audio/video is monitored.", isOn: $consent)
                        if pairing.isHTTP {
                            Toggle("Trusted Wi-Fi demo: I understand HTTP pairing is unencrypted. Use synthetic exam data only.", isOn: $insecureDemo)
                        }
                        Button("Connect to laptop") { controller.connect(acceptInsecureDemo: insecureDemo) }
                            .buttonStyle(.borderedProminent)
                            .disabled(!consent || controller.busy || (pairing.isHTTP && !insecureDemo))
                    }
                    if controller.paired {
                        DeskCameraSection(controller: controller)
                        Button("Stop and forget pairing", role: .destructive) { controller.stopAndForget() }
                        Text("This does not disable the laptop requirement. Force-quitting also forgets pairing; scan a fresh QR to reconnect.").font(.caption)
                    } else {
                        Text("Install this app, then use the iPhone Camera app to scan the laptop QR and tap the link. Come back here to confirm the address.")
                        DisclosureGroup("Enter pairing link manually") {
                            TextField("examcompanion://pair?…", text: $pastedLink)
                                .textInputAutocapitalization(.never).autocorrectionDisabled()
                            Button("Use pairing link") {
                                UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
                                controller.acceptLink(pastedLink); pastedLink = ""; consent = false; insecureDemo = false
                            }
                        }
                    }
                    Text("The exam deadline keeps running. Keep the phone charged. An incoming call or Control Center may briefly make the app inactive.").font(.footnote)
                }.padding(24)
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle("Exam Companion")
            .onAppear { controller.setActive(phase == .active) }
            .modifier(PhaseChange(phase: phase) { controller.setActive($0 == .active) })
            .onOpenURL { url in
                consent = false; insecureDemo = false
                controller.acceptLink(url.absoluteString)
            }
        }
    }
}
