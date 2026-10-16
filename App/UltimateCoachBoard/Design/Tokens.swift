import SwiftUI
import simd

/// Design tokens of blueprint Section 1.2. Colours are specified in sRGB; Phase 1 renders in sRGB
/// (the extended linear Display P3 / EDR pipeline arrives with the 3D renderer in Phase 2).
enum Tokens {
    static let canvasBase = RGBA(hex: 0x050814)
    static let canvasRaised = RGBA(hex: 0x0A0F24)
    static let accent = RGBA(hex: 0xFF007F)
    static let accentActive = RGBA(hex: 0xFF1493)
    static let white = RGBA(hex: 0xFFFFFF)
    static let opponent = RGBA(hex: 0x00F0FF)
    static let fault = RGBA(hex: 0xFF3B1A)

    static let courtLine = accent.withAlpha(0.72)
    static let hairline = white.withAlpha(0.08)
    static let textSecondary = white.withAlpha(0.64)
    static let gridMinor = white.withAlpha(0.06)

    /// Touch target classes (Section 1.5), in points.
    static let targetStandard: CGFloat = 44
    static let targetLivePrimary: CGFloat = 60
    static let targetLiveCritical: CGFloat = 88

    static let railWidth: CGFloat = 64
    static let statusHeight: CGFloat = 32
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
    /// Live numerals: SF Pro Expanded, monospaced digits.
    static let liveNumerals = Font.system(size: 30, weight: .bold).width(.expanded).monospacedDigit()
    /// Section labels: SF Pro Expanded, uppercase in use.
    static let sectionLabel = Font.system(size: 12, weight: .semibold).width(.expanded)
    static let dataMono = Font.system(size: 13, weight: .medium, design: .monospaced)
}
