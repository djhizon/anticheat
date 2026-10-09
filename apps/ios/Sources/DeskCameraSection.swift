import SwiftUI

struct DeskCameraSection: View {
    @ObservedObject var controller: PresenceController
    @ObservedObject var camera: DeskCameraController
    init(controller: PresenceController) { self.controller = controller; camera = controller.deskCamera }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Toggle("Desk camera (optional)", isOn: Binding(get: { controller.deskCameraWanted },
                                                            set: { controller.setDeskCamera($0) }))
            Text("Stand the phone to the side so the back camera sees your keyboard and screen. The phone counts people, checks for hands near the keyboard and checks the framing, all on this device. Only those yes/no and count results are sent to your laptop. No pictures or video are saved or sent.").font(.footnote)
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
                    }
                }
            }
        }
    }
}
