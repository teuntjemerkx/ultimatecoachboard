import SwiftUI
import Observation

/// A visual template: palette for the UI, the board and the avatars, plus a few layout choices.
///
/// The choice of templates follows the research summarized in `docs/THEMES.md`: sports halls are lit at
/// 300 to 750 lux (EN 12193 classes III to I), where dark text on a light background (positive polarity) reads
/// better, especially at small sizes; blue against orange is the team pairing that survives every common colour
/// vision deficiency (Okabe-Ito); text keeps at least 4.5:1 contrast and large text and controls 3:1 (WCAG 2).
struct Theme: Identifiable, Hashable {
    let id: String
    let name: String
    let summary: String
    let recommended: Bool
    let isDark: Bool

    // UI
    let background: RGBA
    let surface: RGBA
    let hairline: RGBA
    let text: RGBA
    let textSecondary: RGBA
    /// Primary actions and selected chips; `onAccent` is the text drawn on it.
    let accent: RGBA
    let onAccent: RGBA
    let fault: RGBA

    // Teams (rings, avatars' jerseys, routes, zones by default)
    let home: RGBA
    let opponent: RGBA
    /// Interior of a token, under its number.
    let tokenFill: RGBA
    let tokenLabel: RGBA
    let liberoJersey: RGBA

    // Board
    let hall: RGBA
    let freeZone: RGBA
    let court: RGBA
    let courtLine: RGBA
    let grid: RGBA
    let net: RGBA
    let ink: RGBA
    let ball: RGBA
    let zoneA: RGBA
    let zoneB: RGBA

    // Avatars
    let skin: RGBA
    let shorts: RGBA
    let pads: RGBA
    let shoes: RGBA
    let hair: RGBA

    // Layout
    let cornerRadius: CGFloat
    let fontWidth: Font.Width
    let fontDesign: Font.Design
    /// Size of the live score in the status bar.
    let scoreSize: CGFloat

    static func == (a: Theme, b: Theme) -> Bool { a.id == b.id }
    func hash(into h: inout Hasher) { h.combine(id) }
}

extension Theme {
    /// Recommended for live use in a lit hall: positive polarity, colour-blind-safe blue and orange teams,
    /// neutral ink for actions so the team colours stay unambiguous.
    static let hall = Theme(
        id: "hall", name: "Sports hall", summary: "Light, high contrast for a lit hall. Blue vs orange, readable with colour blindness.",
        recommended: true, isDark: false,
        background: RGBA(hex: 0xF4F6F9), surface: RGBA(hex: 0xFFFFFF), hairline: RGBA(hex: 0x111827, alpha: 0.12),
        text: RGBA(hex: 0x111827), textSecondary: RGBA(hex: 0x4B5563), accent: RGBA(hex: 0x111827), onAccent: RGBA(hex: 0xFFFFFF),
        fault: RGBA(hex: 0xC2410C),
        home: RGBA(hex: 0x0067A5), opponent: RGBA(hex: 0xD55E00), tokenFill: RGBA(hex: 0xFFFFFF), tokenLabel: RGBA(hex: 0x111827),
        liberoJersey: RGBA(hex: 0xF5F5F5),
        hall: RGBA(hex: 0xEEF1F5), freeZone: RGBA(hex: 0xD9E2EC), court: RGBA(hex: 0xF7F3EA), courtLine: RGBA(hex: 0x1F2937),
        grid: RGBA(hex: 0x1F2937, alpha: 0.10), net: RGBA(hex: 0x111827), ink: RGBA(hex: 0x7C3AED), ball: RGBA(hex: 0xF2B705),
        zoneA: RGBA(hex: 0x0067A5), zoneB: RGBA(hex: 0xD55E00),
        skin: RGBA(hex: 0xC9A68A), shorts: RGBA(hex: 0x1F2937), pads: RGBA(hex: 0x374151), shoes: RGBA(hex: 0xFFFFFF), hair: RGBA(hex: 0x2B2118),
        cornerRadius: 10, fontWidth: .standard, fontDesign: .default, scoreSize: 32)

    /// Dark counterpart for dim rooms and video review: the same colour-blind-safe pairing, brightened for a dark ground.
    static let night = Theme(
        id: "night", name: "Evening", summary: "Dark, calm and colour-blind-safe. For dim rooms, video and night use.",
        recommended: false, isDark: true,
        background: RGBA(hex: 0x0E1116), surface: RGBA(hex: 0x181C24), hairline: RGBA(hex: 0xFFFFFF, alpha: 0.10),
        text: RGBA(hex: 0xE8EAED), textSecondary: RGBA(hex: 0x9AA4B2), accent: RGBA(hex: 0xE8EAED), onAccent: RGBA(hex: 0x0E1116),
        fault: RGBA(hex: 0xFF7A45),
        home: RGBA(hex: 0x56B4E9), opponent: RGBA(hex: 0xE69F00), tokenFill: RGBA(hex: 0x0E1116, alpha: 0.85), tokenLabel: RGBA(hex: 0xFFFFFF),
        liberoJersey: RGBA(hex: 0xE8EAED),
        hall: RGBA(hex: 0x0B0E13), freeZone: RGBA(hex: 0x121822), court: RGBA(hex: 0x1A2230), courtLine: RGBA(hex: 0xC9D1DC),
        grid: RGBA(hex: 0xFFFFFF, alpha: 0.06), net: RGBA(hex: 0xE8EAED), ink: RGBA(hex: 0xC084FC), ball: RGBA(hex: 0xFFE14D),
        zoneA: RGBA(hex: 0x56B4E9), zoneB: RGBA(hex: 0xE69F00),
        skin: RGBA(hex: 0x8D7A6E), shorts: RGBA(hex: 0x1C2533), pads: RGBA(hex: 0x2A3445), shoes: RGBA(hex: 0xE8EAED), hair: RGBA(hex: 0x15110E),
        cornerRadius: 10, fontWidth: .standard, fontDesign: .default, scoreSize: 32)

    /// Television graphics: a coloured court with a contrasting free zone and white lines (the FIVB court rule),
    /// condensed heavy type, a big score.
    static let broadcast = Theme(
        id: "broadcast", name: "TV broadcast", summary: "Terracotta court, blue free zone, white lines and a big scoreboard, like on TV.",
        recommended: false, isDark: true,
        background: RGBA(hex: 0x0A1A33), surface: RGBA(hex: 0x10284D), hairline: RGBA(hex: 0xFFFFFF, alpha: 0.14),
        text: RGBA(hex: 0xFFFFFF), textSecondary: RGBA(hex: 0xB8C4D9), accent: RGBA(hex: 0xFFD23F), onAccent: RGBA(hex: 0x0A1A33),
        fault: RGBA(hex: 0xFF5A36),
        home: RGBA(hex: 0xFFD23F), opponent: RGBA(hex: 0xFFFFFF), tokenFill: RGBA(hex: 0x0A1A33, alpha: 0.92), tokenLabel: RGBA(hex: 0xFFFFFF),
        liberoJersey: RGBA(hex: 0x2EC4B6),
        hall: RGBA(hex: 0x0A1A33), freeZone: RGBA(hex: 0x1D4E89), court: RGBA(hex: 0xB8501F), courtLine: RGBA(hex: 0xFFFFFF),
        grid: RGBA(hex: 0xFFFFFF, alpha: 0.10), net: RGBA(hex: 0xFFFFFF), ink: RGBA(hex: 0x2EC4B6), ball: RGBA(hex: 0xFFE14D),
        zoneA: RGBA(hex: 0xFFD23F), zoneB: RGBA(hex: 0xFFFFFF),
        skin: RGBA(hex: 0xB08A72), shorts: RGBA(hex: 0x0A1A33), pads: RGBA(hex: 0x10284D), shoes: RGBA(hex: 0xFFFFFF), hair: RGBA(hex: 0x1A120D),
        cornerRadius: 3, fontWidth: .condensed, fontDesign: .default, scoreSize: 40)

    /// The coach's whiteboard: white board, black court, red and blue markers, rounded type.
    static let whiteboard = Theme(
        id: "whiteboard", name: "Whiteboard", summary: "Like the board in the gym: white, black lines, red and blue markers.",
        recommended: false, isDark: false,
        background: RGBA(hex: 0xECECE8), surface: RGBA(hex: 0xFFFFFF), hairline: RGBA(hex: 0x1A1A1A, alpha: 0.14),
        text: RGBA(hex: 0x1A1A1A), textSecondary: RGBA(hex: 0x5C5C58), accent: RGBA(hex: 0x1A1A1A), onAccent: RGBA(hex: 0xFFFFFF),
        fault: RGBA(hex: 0xB91C1C),
        home: RGBA(hex: 0xD62828), opponent: RGBA(hex: 0x1D4ED8), tokenFill: RGBA(hex: 0xFFFFFF), tokenLabel: RGBA(hex: 0x1A1A1A),
        liberoJersey: RGBA(hex: 0x16A34A),
        hall: RGBA(hex: 0xFFFFFF), freeZone: RGBA(hex: 0xFFFFFF), court: RGBA(hex: 0xFFFFFF), courtLine: RGBA(hex: 0x1A1A1A),
        grid: RGBA(hex: 0x1A1A1A, alpha: 0.08), net: RGBA(hex: 0x1A1A1A), ink: RGBA(hex: 0x16A34A), ball: RGBA(hex: 0xF2B705),
        zoneA: RGBA(hex: 0xD62828), zoneB: RGBA(hex: 0x1D4ED8),
        skin: RGBA(hex: 0xC9A68A), shorts: RGBA(hex: 0x1A1A1A), pads: RGBA(hex: 0x3F3F3F), shoes: RGBA(hex: 0xFFFFFF), hair: RGBA(hex: 0x2B2118),
        cornerRadius: 14, fontWidth: .standard, fontDesign: .rounded, scoreSize: 32)

    /// The original cyber-tactical look of the blueprint (Section 1.2).
    static let neon = Theme(
        id: "neon", name: "Neon", summary: "The original: neon pink and cyan on deep navy.",
        recommended: false, isDark: true,
        background: RGBA(hex: 0x050814), surface: RGBA(hex: 0x0A0F24), hairline: RGBA(hex: 0xFFFFFF, alpha: 0.08),
        text: RGBA(hex: 0xFFFFFF), textSecondary: RGBA(hex: 0xFFFFFF, alpha: 0.64), accent: RGBA(hex: 0xFF007F), onAccent: RGBA(hex: 0x050814),
        fault: RGBA(hex: 0xFF3B1A),
        home: RGBA(hex: 0xFF007F), opponent: RGBA(hex: 0x00F0FF), tokenFill: RGBA(hex: 0x050814, alpha: 0.8), tokenLabel: RGBA(hex: 0xFFFFFF),
        liberoJersey: RGBA(hex: 0xFFFFFF),
        hall: RGBA(hex: 0x050814), freeZone: RGBA(hex: 0x050814), court: RGBA(hex: 0x0A0F24), courtLine: RGBA(hex: 0xFF007F, alpha: 0.72),
        grid: RGBA(hex: 0xFFFFFF, alpha: 0.06), net: RGBA(hex: 0xFFFFFF), ink: RGBA(hex: 0xFF1493), ball: RGBA(hex: 0xFFE14D),
        zoneA: RGBA(hex: 0xFF007F), zoneB: RGBA(hex: 0x00F0FF),
        skin: RGBA(hex: 0x6B7899), shorts: RGBA(hex: 0x11183A), pads: RGBA(hex: 0x1E2752), shoes: RGBA(hex: 0xE8ECF5), hair: RGBA(hex: 0x0B1024),
        cornerRadius: 4, fontWidth: .expanded, fontDesign: .default, scoreSize: 28)

    static let all: [Theme] = [.hall, .night, .broadcast, .whiteboard, .neon]
}

/// How the court sits on the screen.
enum CourtOrientation: String, CaseIterable, Identifiable {
    /// The court's long axis follows the screen's long side, so the court fills the screen in both orientations.
    case auto
    /// Always across the screen, as seen from the bench.
    case horizontal

    var id: String { rawValue }
    var title: String { self == .auto ? "Fill the screen" : "Always horizontal" }
}

/// The selected template and layout choices, persisted in user defaults. Views that read `Tokens` re-render when
/// the template changes (Observation tracks the access).
@Observable
final class ThemeStore {
    static let shared = ThemeStore()

    private(set) var theme: Theme
    private(set) var courtOrientation: CourtOrientation

    func select(_ theme: Theme) {
        self.theme = theme
        UserDefaults.standard.set(theme.id, forKey: "themeID")
    }

    func setCourtOrientation(_ orientation: CourtOrientation) {
        courtOrientation = orientation
        UserDefaults.standard.set(orientation.rawValue, forKey: "courtOrientation")
    }

    private init() {
        // The research-recommended template is the default; demo screens may pick another with -theme <id>.
        let args = ProcessInfo.processInfo.arguments
        let launchTheme = args.firstIndex(of: "-theme").flatMap { args.indices.contains($0 + 1) ? args[$0 + 1] : nil }
        let id = launchTheme ?? UserDefaults.standard.string(forKey: "themeID") ?? Theme.hall.id
        theme = Theme.all.first { $0.id == id } ?? .hall
        courtOrientation = CourtOrientation(rawValue: UserDefaults.standard.string(forKey: "courtOrientation") ?? "") ?? .auto
    }
}
