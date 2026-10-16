import SwiftUI
import CoachBoardCore
import simd

/// Design tokens (blueprint Section 1.2), resolved from the selected template (`Theme`, Settings > Appearance).
/// Names are semantic: `background`, `surface`, `text`, `home`, `opponent`, `accent` (actions), board colours.
/// The older names (`canvasBase`, `canvasRaised`, `accentActive`) remain as aliases.
enum Tokens {
    static var theme: Theme { ThemeStore.shared.theme }

    static var background: RGBA { theme.background }
    static var surface: RGBA { theme.surface }
    static var text: RGBA { theme.text }
    static var textSecondary: RGBA { theme.textSecondary }
    static var hairline: RGBA { theme.hairline }
    static var accent: RGBA { theme.accent }
    static var onAccent: RGBA { theme.onAccent }
    static var fault: RGBA { theme.fault }

    static var home: RGBA { theme.home }
    static var opponent: RGBA { theme.opponent }
    static func team(_ side: Side) -> RGBA { side == .home ? theme.home : theme.opponent }
    static var tokenFill: RGBA { theme.tokenFill }
    static var tokenLabel: RGBA { theme.tokenLabel }
    static var liberoJersey: RGBA { theme.liberoJersey }

    static var hall: RGBA { theme.hall }
    static var freeZone: RGBA { theme.freeZone }
    static var court: RGBA { theme.court }
    static var courtLine: RGBA { theme.courtLine }
    static var gridMinor: RGBA { theme.grid }
    static var net: RGBA { theme.net }
    static var ink: RGBA { theme.ink }
    static var ball: RGBA { theme.ball }
    static var zoneA: RGBA { theme.zoneA }
    static var zoneB: RGBA { theme.zoneB }

    // Aliases from the first palette.
    static var canvasBase: RGBA { background }
    static var canvasRaised: RGBA { surface }
    static var accentActive: RGBA { ink }
    /// Literal white (labels on dark fills, highlights); use `text` for ordinary text.
    static let white = RGBA(hex: 0xFFFFFF)

    static var cornerRadius: CGFloat { theme.cornerRadius }
    static var radiusSmall: CGFloat { (theme.cornerRadius * 0.6).rounded() }

    /// Touch target classes (Section 1.5), in points.
    static let targetStandard: CGFloat = 44
    static let targetLivePrimary: CGFloat = 60
    static let targetLiveCritical: CGFloat = 88

    static let railWidth: CGFloat = 72
    static let statusHeight: CGFloat = 52
}

struct RGBA: Hashable {
    var r: Double, g: Double, b: Double, a: Double

    init(r: Double, g: Double, b: Double, a: Double = 1) {
        self.r = r; self.g = g; self.b = b; self.a = a
    }

    init(hex: UInt32, alpha: Double = 1) {
        self.init(r: Double((hex >> 16) & 0xFF) / 255, g: Double((hex >> 8) & 0xFF) / 255, b: Double(hex & 0xFF) / 255, a: alpha)
    }

    func withAlpha(_ alpha: Double) -> RGBA { RGBA(r: r, g: g, b: b, a: alpha) }

    var color: Color { Color(.sRGB, red: r, green: g, blue: b, opacity: a) }
    var simd: SIMD4<Float> { SIMD4(Float(r), Float(g), Float(b), Float(a)) }
}

extension Font {
    /// Live numerals in the template's type: monospaced digits so the score never jitters.
    static var liveNumerals: Font { themed(30, .bold).monospacedDigit() }
    /// The live score in the status bar: the template decides how big (research: a glance at arm's length).
    static var liveScore: Font { themed(Tokens.theme.scoreSize, .heavy).monospacedDigit() }
    /// Section labels, uppercase in use.
    static var sectionLabel: Font { themed(13, .semibold) }
    static var dataMono: Font { Font.system(size: 14, weight: .medium, design: .monospaced) }

    /// A system font in the template's design and width.
    static func themed(_ size: CGFloat, _ weight: Font.Weight) -> Font {
        Font.system(size: size, weight: weight, design: Tokens.theme.fontDesign).width(Tokens.theme.fontWidth)
    }
}
