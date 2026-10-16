import UIKit
import CoreHaptics
import AudioToolbox
import Observation
import CoachBoardCore

/// Eyes-free confirmation (blueprint Section 1.6, revised): iPads have no Taptic Engine, so the primary channel
/// is a luminance pulse around the screen edge, which peripheral vision catches while the coach watches the rally.
/// Optional channels: a short click sound (off by default) and Core Haptics where the hardware supports it.
/// Apple Pencil Pro haptics are triggered by the board itself when an ink stroke completes.
@MainActor
@Observable
final class Feedback {
    static let shared = Feedback()

    struct Cue: Equatable {
        var id = UUID()
        var pattern: HapticPattern
        /// Number of pulses (1 = accepted, 2 = committed, 3 = side-out).
        var pulses: Int
        var color: RGBA
    }

    private(set) var cue: Cue?
    @ObservationIgnored private var engine: CHHapticEngine?
    var soundEnabled: Bool { UserDefaults.standard.bool(forKey: "feedbackSound") }

    private init() {
        guard CHHapticEngine.capabilitiesForHardware().supportsHaptics, let e = try? CHHapticEngine() else { return }
        e.isAutoShutdownEnabled = true
        e.resetHandler = { [weak e] in try? e?.start() }   // runs on Core Haptics' queue; touches only the engine
        try? e.start()
        engine = e
    }

    func play(_ pattern: HapticPattern) {
        let spec: (Int, RGBA)
        switch pattern {
        case .originAccepted: spec = (1, Tokens.accent)
        case .landingAccepted: spec = (2, Tokens.accent)
        case .rejected: spec = (1, Tokens.text.withAlpha(0.35))
        case .point: spec = (1, Tokens.text)
        case .sideOut: spec = (3, Tokens.text)
        case .overlapWarning: spec = (1, Tokens.fault)
        case .overlapFault: spec = (2, Tokens.fault)
        case .panic: spec = (1, Tokens.fault)
        case .undo: spec = (1, Tokens.text.withAlpha(0.5))
        }
        cue = Cue(pattern: pattern, pulses: spec.0, color: spec.1)
        if soundEnabled && pattern != .rejected {
            for i in 0..<spec.0 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.08 * Double(i)) { AudioServicesPlaySystemSound(1104) }
            }
        }
        playHaptic(pulses: spec.0, strong: pattern == .overlapFault || pattern == .panic)
    }

    private func playHaptic(pulses: Int, strong: Bool) {
        guard let engine else { return }
        let events = (0..<pulses).map { i in
            CHHapticEvent(eventType: .hapticTransient, parameters: [
                CHHapticEventParameter(parameterID: .hapticIntensity, value: strong ? 1.0 : 0.7),
                CHHapticEventParameter(parameterID: .hapticSharpness, value: 0.7),
            ], relativeTime: 0.06 * Double(i))
        }
        if let pattern = try? CHHapticPattern(events: events, parameters: []),
           let player = try? engine.makePlayer(with: pattern) {
            try? player.start(atTime: CHHapticTimeImmediate)
        }
    }
}
