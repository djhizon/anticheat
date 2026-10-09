import SwiftUI

struct DeskCameraSection: View {
    @ObservedObject var controller: PresenceController
    @ObservedObject var camera: DeskCameraController
    init(controller: PresenceController) { self.controller = controller; camera = controller.deskCamera }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Toggle("Desk camera (optional)", isOn: Binding(get: { controller.deskCameraWanted },
                                                            set: { controller.setDeskCamera($0) }))
            Text("Stand the phone to the side so the back camera sees your keyboard and screen. The phone analyses the picture on this device only, to count people and faces, count hands (more than two is flagged), spot a readable page or a phone-like object on the desk, and notice if the lens is covered or dark. Only those yes/no flags and counts are sent to your laptop. No video is ever recorded or sent. If something unusual is detected, one still photo is sent to your instructor and shown in your report (at most one per kind of event every 30 seconds).").font(.footnote)
            if controller.deskCameraWanted {
                Text(camera.message).font(.caption)
                if camera.running {
                    ZStack {
                        CameraPreview(session: camera.session)
                        // Framing guide: keep the keyboard inside the dashed box, screen above it.
                        GeometryReader { geo in
                            RoundedRectangle(cornerRadius: 8).stroke(.green, style: StrokeStyle(lineWidth: 2, dash: [6]))
                                .frame(width: geo.size.width * 0.8, height: geo.size.height * 0.55)
                                .position(x: geo.size.width / 2, y: geo.size.height * 0.725)
                            Text("Keyboard here").font(.caption2).foregroundStyle(.green)
                                .position(x: geo.size.width / 2, y: geo.size.height * 0.95)
                        }
                    }
                    .frame(height: 320).clipShape(RoundedRectangle(cornerRadius: 12))
                    if let s = camera.latest {
                        Text("People: \(s.people) · Hands near keyboard: \(s.handsVisible ? "yes" : "no") · Framing: \(s.framingOk ? "OK" : "adjust")").font(.caption)
                        Text("Hands: \(s.handCount) · Extra person: \(s.extraPerson ? "yes" : "no") · Extra hands: \(s.extraHands ? "yes" : "no") · Text on desk: \(s.textVisible ? "yes" : "no") · Lens blocked: \(s.cameraObstructed ? "yes" : "no")\(s.objectHints.isEmpty ? "" : " · Objects: " + s.objectHints.joined(separator: ", "))")
                            .font(.caption).accessibilityIdentifier("desk-flags")
                    }
                }
            }
        }
    }
}
