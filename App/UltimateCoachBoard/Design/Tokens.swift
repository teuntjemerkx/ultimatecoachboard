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
    /// Primary buttons on the coach screens (Start match, Resume, Next set): at least 56 pt tall.
    static let targetPrimary: CGFloat = 56

    /// Cards and panels: a little rounder than controls.
    static var radiusCard: CGFloat { (theme.cornerRadius * 1.4).rounded() }

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
    /// Group titles on the coach screens, in sentence case: the larger, readable counterpart of `sectionLabel`.
    static var groupTitle: Font { themed(17, .semibold) }

    /// A system font in the template's design and width.
    static func themed(_ size: CGFloat, _ weight: Font.Weight) -> Font {
        Font.system(size: size, weight: weight, design: Tokens.theme.fontDesign).width(Tokens.theme.fontWidth)
    }

    /// A text style in the template's design and width that follows Dynamic Type.
    static func scaled(_ style: Font.TextStyle, _ weight: Font.Weight = .regular) -> Font {
        Font.system(style, design: Tokens.theme.fontDesign, weight: weight).width(Tokens.theme.fontWidth)
    }
}

// MARK: - Shared controls of the coach screens

extension View {
    /// The standard card: surface fill, a hairline border and the card radius.
    func coachCard(padding: CGFloat = 20) -> some View {
        self.padding(padding)
            .background(Tokens.surface.color, in: RoundedRectangle(cornerRadius: Tokens.radiusCard))
            .overlay(RoundedRectangle(cornerRadius: Tokens.radiusCard).stroke(Tokens.hairline.color))
    }
}

/// Buttons of the coach screens: one filled primary action per screen, outlined secondary actions and quiet
/// text actions. Colours follow the template; a disabled primary button greys out.
struct CoachButtonStyle: ButtonStyle {
    enum Kind { case primary, secondary, quiet }
    var kind: Kind = .primary
    var fullWidth = false
    var minHeight: CGFloat = Tokens.targetPrimary

    func makeBody(configuration: Configuration) -> some View {
        CoachButtonBody(configuration: configuration, kind: kind, fullWidth: fullWidth, minHeight: minHeight)
    }
}

/// The look of `CoachButtonStyle`; a view of its own so it can read whether the button is enabled.
struct CoachButtonBody: View {
    let configuration: ButtonStyleConfiguration
    let kind: CoachButtonStyle.Kind
    let fullWidth: Bool
    let minHeight: CGFloat
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Tokens.cornerRadius)
        configuration.label
            .font(Font.themed(kind == .quiet ? 17 : 18, kind == .quiet ? Font.Weight.semibold : Font.Weight.bold))
            .lineLimit(1)
            .minimumScaleFactor(0.8)
            .padding(.horizontal, kind == .quiet ? 12 : 24)
            .frame(maxWidth: fullWidth ? .infinity : nil, minHeight: minHeight)
            .foregroundStyle(foreground.color)
            .background(background.color, in: shape)
            .overlay(shape.stroke(border.color, lineWidth: 1.5))
            .contentShape(shape)
            .opacity(configuration.isPressed ? 0.7 : 1)
    }

    private var foreground: RGBA {
        switch kind {
        case .primary: return isEnabled ? Tokens.onAccent : Tokens.textSecondary
        case .secondary, .quiet: return isEnabled ? Tokens.text : Tokens.textSecondary
        }
    }

    private var background: RGBA {
        switch kind {
        case .primary: return isEnabled ? Tokens.accent : Tokens.hairline
        case .secondary: return Tokens.surface
        case .quiet: return Tokens.surface.withAlpha(0)
        }
    }

    private var border: RGBA {
        kind == .secondary ? Tokens.text.withAlpha(isEnabled ? 0.35 : 0.15) : Tokens.hairline.withAlpha(0)
    }
}

/// A large segmented choice (at least 44 pt tall per option); the selected option is filled.
struct ChoiceBar<Value: Hashable>: View {
    let options: [(value: Value, title: String)]
    @Binding var selection: Value

    var body: some View {
        HStack(spacing: 4) {
            ForEach(options.indices, id: \.self) { i in
                let option = options[i]
                let on = option.value == selection
                Button { selection = option.value } label: {
                    Text(option.title)
                        .font(.themed(17, .semibold))
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                        .padding(.horizontal, 8)
                        .frame(maxWidth: .infinity, minHeight: Tokens.targetStandard)
                        .foregroundStyle(on ? Tokens.onAccent.color : Tokens.text.color)
                        .background(on ? Tokens.accent.color : Tokens.accent.withAlpha(0).color,
                                    in: RoundedRectangle(cornerRadius: Tokens.radiusSmall))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(on ? .isSelected : [])
            }
        }
        .padding(4)
        .background(Tokens.background.color, in: RoundedRectangle(cornerRadius: Tokens.radiusSmall + 4))
        .overlay(RoundedRectangle(cornerRadius: Tokens.radiusSmall + 4).stroke(Tokens.hairline.color))
    }
}

/// An empty state: one helpful line and, when there is something to do, one button.
struct EmptyHint: View {
    let symbol: String
    let message: String
    var actionTitle: String? = nil
    var action: (() -> Void)? = nil

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: symbol)
                .font(.themed(34, .regular))
                .foregroundStyle(Tokens.textSecondary.color)
            Text(message)
                .font(.scaled(.body))
                .multilineTextAlignment(.center)
                .foregroundStyle(Tokens.textSecondary.color)
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .buttonStyle(CoachButtonStyle(kind: .secondary))
            }
        }
        .padding(24)
        .frame(maxWidth: 420)
    }
}
