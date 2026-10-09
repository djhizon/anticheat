import SwiftUI

/// iOS 16 deployment target: the two-parameter onChange needs iOS 17, and the one-parameter form is deprecated there.
struct PhaseChange: ViewModifier {
    let phase: ScenePhase
    let action: (ScenePhase) -> Void
    func body(content: Content) -> some View {
        if #available(iOS 17.0, *) {
            content.onChange(of: phase) { _, new in action(new) }
        } else {
            content.onChange(of: phase) { action($0) }
        }
    }
}
