import UIKit
import CoreText
import Metal
import CoachBoardCore

/// Jersey numbers and role letters as a signed distance field atlas (Section 3.2): glyphs are rendered once
/// with CoreText into an 8-bit coverage bitmap, turned into a distance field and sampled with a smoothstep,
/// so labels stay crisp at every zoom. (A multi-channel field for sharper corners can replace it later.)
final class GlyphAtlas {
    struct Glyph {
        var uvOrigin: SIMD2<Float>
        var uvSize: SIMD2<Float>
        /// Advance width relative to the cell height.
        var advance: Float
        /// Quad width relative to the cell height (advance plus the distance-field margin on both sides).
        var quadAspect: Float
    }

    static let characters = Array("0123456789SOHMBPLAFCDE")
    static let cell = 96
    static let columns = 8
    /// Pixels of distance encoded on each side of an edge; also the margin around every glyph.
    static let spread: Float = 10

    private struct Bitmap {
        var width: Int
        var height: Int
        var sdf: [UInt8]
        var glyphs: [Character: Glyph]
    }

    /// Built once per process; textures are made per device from it.
    private static let bitmap: Bitmap? = makeBitmap()

    let texture: MTLTexture
    let glyphs: [Character: Glyph]

    init?(device: MTLDevice) {
        guard let b = Self.bitmap else { return nil }
        let desc = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .r8Unorm, width: b.width, height: b.height, mipmapped: false)
        desc.usage = .shaderRead
        desc.storageMode = .shared
        guard let tex = device.makeTexture(descriptor: desc) else { return nil }
        b.sdf.withUnsafeBytes { raw in
            tex.replace(region: MTLRegionMake2D(0, 0, b.width, b.height), mipmapLevel: 0,
                        withBytes: raw.baseAddress!, bytesPerRow: b.width)
        }
        texture = tex
        glyphs = b.glyphs
    }

    private static func makeBitmap() -> Bitmap? {
        let rows = (characters.count + columns - 1) / columns
        let width = cell * columns, height = cell * rows
        var coverage = [UInt8](repeating: 0, count: width * height)
        let font = UIFont.systemFont(ofSize: CGFloat(cell) * 0.66, weight: .heavy, width: .condensed) as CTFont
        let white = CGColor(gray: 1, alpha: 1)
        var advances: [Character: CGFloat] = [:]
        let drawn: Bool = coverage.withUnsafeMutableBytes { raw in
            guard let ctx = CGContext(data: raw.baseAddress, width: width, height: height, bitsPerComponent: 8,
                                      bytesPerRow: width, space: CGColorSpaceCreateDeviceGray(),
                                      bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return false }
            ctx.setShouldAntialias(true)
            for (i, ch) in characters.enumerated() {
                let text = NSAttributedString(string: String(ch), attributes: [
                    NSAttributedString.Key(kCTFontAttributeName as String): font,
                    NSAttributedString.Key(kCTForegroundColorAttributeName as String): white,
                ])
                let line = CTLineCreateWithAttributedString(text)
                let bounds = CTLineGetBoundsWithOptions(line, .useGlyphPathBounds)
                advances[ch] = bounds.width
                let col = i % columns, row = i / columns
                // Bitmap memory starts at the top row; CoreGraphics' origin is bottom-left.
                let cellMinY = CGFloat(height - (row + 1) * cell)
                ctx.textPosition = CGPoint(x: CGFloat(col * cell) + (CGFloat(cell) - bounds.width) / 2 - bounds.minX,
                                           y: cellMinY + (CGFloat(cell) - bounds.height) / 2 - bounds.minY)
                CTLineDraw(line, ctx)
            }
            return true
        }
        guard drawn else { return nil }
        let sdf = SignedDistance.field(coverage: coverage, width: width, height: height, spread: spread)
        var glyphs: [Character: Glyph] = [:]
        let c = CGFloat(cell), pad = CGFloat(spread)
        for (i, ch) in characters.enumerated() {
            let w = advances[ch] ?? c * 0.5
            let col = i % columns, row = i / columns
            let u0 = (CGFloat(col) * c + (c - w) / 2 - pad) / CGFloat(width)
            let v0 = CGFloat(row) * c / CGFloat(height)
            glyphs[ch] = Glyph(uvOrigin: SIMD2(Float(u0), Float(v0)),
                               uvSize: SIMD2(Float((w + 2 * pad) / CGFloat(width)), Float(c / CGFloat(height))),
                               advance: Float(w / c), quadAspect: Float((w + 2 * pad) / c))
        }
        return Bitmap(width: width, height: height, sdf: sdf, glyphs: glyphs)
    }

    /// Glyph quads for a label centred at `center`, `height` points per cell, in view points.
    func layout(_ text: String, center: CGPoint, height: CGFloat, color: SIMD4<Float>) -> [GlyphInstance] {
        let items = text.compactMap { glyphs[$0] }
        guard !items.isEmpty else { return [] }
        let h = Float(height)
        let tracking = 0.04 * h
        let total = items.reduce(Float(0)) { $0 + $1.advance * h } + tracking * Float(items.count - 1)
        let margin = Self.spread / Float(Self.cell) * h
        var x = Float(center.x) - total / 2
        var out: [GlyphInstance] = []
        for g in items {
            out.append(GlyphInstance(origin: SIMD2(x - margin, Float(center.y) - h / 2),
                                     size: SIMD2(g.quadAspect * h, h), uvOrigin: g.uvOrigin, uvSize: g.uvSize, color: color))
            x += g.advance * h + tracking
        }
        return out
    }
}
