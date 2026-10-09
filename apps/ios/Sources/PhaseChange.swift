import SwiftUI

/// iOS 16 deployment target: the two-parameter onChange needs iOS 17, and the one-parameter form is deprecated there.
struct ValueChange<Value: Equatable>: ViewModifier {
    let value: Value
    let action: (Value) -> Void
    func body(content: Content) -> some View {
        if #available(iOS 17.0, *) {
            content.onChange(of: value) { _, new in action(new) }
        } else {
            content.onChange(of: value) { action($0) }
        }
    }
}

typealias PhaseChange = ValueChange<ScenePhase>

extension ValueChange where Value == ScenePhase {
    init(phase: ScenePhase, action: @escaping (ScenePhase) -> Void) {
        self.init(value: phase, action: action)
    }
}
