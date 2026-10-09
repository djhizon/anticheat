import SwiftUI

/// A phone drawn with shapes. `landscape` is just a 90 degree rotation of the same drawing.
struct PhoneShape: View {
    var tint: Color = .blue
    var body: some View {
        ZStack(alignment: .top) {
            RoundedRectangle(cornerRadius: 14).fill(Color(.secondarySystemBackground))
            RoundedRectangle(cornerRadius: 14).stroke(tint, lineWidth: 3)
            Capsule().fill(tint.opacity(0.6)).frame(width: 18, height: 4).padding(.top, 6)
        }
        .frame(width: 54, height: 100)
    }
}

/// Step 1: a phone that rotates from upright to sideways, like the "rotate your phone" hint in video apps.
struct RotatePhoneIllustration: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var turned = false
    var body: some View {
        ZStack {
            Image(systemName: "arrow.clockwise")
                .font(.system(size: 34, weight: .semibold)).foregroundStyle(.blue.opacity(0.6))
                .offset(x: 62, y: -52)
            PhoneShape()
                .rotationEffect(.degrees(turned || reduceMotion ? 90 : 0))
        }
        .frame(width: 170, height: 150)
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 1.3).repeatForever(autoreverses: true).delay(0.3)) { turned = true }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Illustration: a phone turning from upright to sideways")
    }
}

/// Top-down diagram: desk, laptop, student, and the phone beside them with its field-of-view cone.
struct DeskDiagram: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pulse = false
    /// Highlights the cone (used on the preview step / repositioning overlay).
    var compact = false

    // Normalised positions inside a square (x right, y down).
    private let laptop = CGPoint(x: 0.42, y: 0.40)
    private let student = CGPoint(x: 0.42, y: 0.80)
    private let phone = CGPoint(x: 0.90, y: 0.38)

    var body: some View {
        GeometryReader { geo in
            let s = min(geo.size.width, geo.size.height)
            let p: (CGPoint) -> CGPoint = { CGPoint(x: $0.x * s, y: $0.y * s) }
            let phonePt = p(phone)
            let target = p(CGPoint(x: 0.42, y: 0.62))     // between keyboard and student
            let heading = atan2(target.y - phonePt.y, target.x - phonePt.x)
            let half = Angle.degrees(28).radians
            ZStack {
                RoundedRectangle(cornerRadius: 10).fill(Color.brown.opacity(0.18))
                RoundedRectangle(cornerRadius: 10).stroke(Color.brown.opacity(0.5), lineWidth: 2)
                // Field-of-view cone.
                Path { path in
                    path.move(to: phonePt)
                    path.addArc(center: phonePt, radius: s * 0.62, startAngle: .radians(heading - half), endAngle: .radians(heading + half), clockwise: false)
                    path.closeSubpath()
                }
                .fill(Color.blue.opacity(pulse && !reduceMotion ? 0.32 : 0.18))
                // Laptop: base (keyboard) + screen line.
                RoundedRectangle(cornerRadius: 3).fill(Color.gray.opacity(0.7))
                    .frame(width: s * 0.30, height: s * 0.14).position(p(CGPoint(x: laptop.x, y: laptop.y + 0.09)))
                RoundedRectangle(cornerRadius: 2).fill(Color.gray)
                    .frame(width: s * 0.30, height: s * 0.025).position(p(CGPoint(x: laptop.x, y: laptop.y - 0.02)))
                // Student.
                Circle().fill(Color.orange).frame(width: s * 0.13, height: s * 0.13).position(p(student))
                Capsule().fill(Color.orange.opacity(0.6)).frame(width: s * 0.26, height: s * 0.07).position(p(CGPoint(x: student.x, y: student.y + 0.09)))
                // ~1 m guide.
                Path { path in path.move(to: p(student)); path.addLine(to: phonePt) }
                    .stroke(Color.secondary, style: StrokeStyle(lineWidth: 1.5, dash: [4, 4]))
                if !compact {
                    Text("about 1 m").font(.caption2.bold()).foregroundStyle(.secondary)
                        .position(p(CGPoint(x: 0.72, y: 0.66)))
                    Text("45°").font(.caption2.bold()).foregroundStyle(.blue)
                        .position(p(CGPoint(x: 0.70, y: 0.36)))
                    Text("Laptop").font(.caption2).foregroundStyle(.secondary).position(p(CGPoint(x: laptop.x, y: 0.16)))
                    Text("You").font(.caption2).foregroundStyle(.secondary).position(p(CGPoint(x: student.x - 0.14, y: student.y)))
                }
                // Phone, landscape, rear camera aimed at you.
                RoundedRectangle(cornerRadius: 4).fill(Color.blue)
                    .frame(width: s * 0.07, height: s * 0.16)
                    .rotationEffect(.radians(heading))
                    .position(phonePt)
            }
            .frame(width: s, height: s)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .aspectRatio(1, contentMode: .fit)
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 1.4).repeatForever(autoreverses: true)) { pulse = true }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Top-down diagram. Your laptop is in front of you. The phone is on your side, about one metre away, turned at 45 degrees toward you and your keyboard, with its camera view shown as a cone.")
    }
}

/// Bubble level: the dot should sit inside the ring, meaning the phone stands upright.
struct TiltLevel: View {
    let tilt: Double?
    let roll: Double?
    var body: some View {
        let ok = PlacementPolicy.tiltOk(tilt)
        VStack(spacing: 6) {
            ZStack {
                Circle().stroke(Color.secondary.opacity(0.5), lineWidth: 2).frame(width: 84, height: 84)
                Circle().stroke(ok ? Color.green : Color.orange, lineWidth: 2).frame(width: 42, height: 42)
                Circle().fill(ok ? Color.green : Color.orange).frame(width: 14, height: 14)
                    .offset(x: clamp((roll ?? 0) / 30 * 42), y: clamp((tilt ?? 0) / 30 * 42))
                    .animation(.easeOut(duration: 0.15), value: tilt)
            }
            .frame(width: 90, height: 90)
            Text(label(ok)).font(.caption.bold()).foregroundStyle(ok ? .green : .orange)
                .multilineTextAlignment(.center)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(a11y(ok))
        .accessibilityIdentifier("placement-level")
    }

    private func clamp(_ v: Double) -> CGFloat { CGFloat(max(-42, min(42, v))) }
    private func label(_ ok: Bool) -> String {
        guard let tilt else { return "Level sensor not available" }
        return ok ? "Upright · \(Int(tilt.rounded()))°" : "Stand it more upright · \(Int(tilt.rounded()))°"
    }
    private func a11y(_ ok: Bool) -> String {
        guard let tilt else { return "Level sensor not available" }
        return ok ? "Phone is upright, tilt \(Int(tilt.rounded())) degrees" : "Phone is leaning, tilt \(Int(tilt.rounded())) degrees. Stand it more upright, within \(Int(PlacementPolicy.maxTiltDegrees)) degrees."
    }
}
