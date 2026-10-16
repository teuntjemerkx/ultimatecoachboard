import UIKit
import Metal
import MetalKit

/// A small glyph atlas for jersey numbers and role letters, rendered once from SF Pro Condensed Heavy.
/// Phase 1 uses a mipmapped coverage atlas; Phase 2 replaces it with a multi-channel SDF atlas (Section 3.2).
final class GlyphAtlas {
    struct Glyph {
        var uvOrigin: SIMD2<Float>
        var uvSize: SIMD2<Float>
        /// Width relative to the cell height.
        var aspect: Float
    }

    static let characters = Array("0123456789SOHMBPLAFCDE")
    let texture: MTLTexture
    private(set) var glyphs: [Character: Glyph] = [:]

    init?(device: MTLDevice) {
        let cell: CGFloat = 128
        let cols = 8
        let rows = Int(ceil(Double(Self.characters.count) / Double(cols)))
        let size = CGSize(width: cell * CGFloat(cols), height: cell * CGFloat(rows))
        let font = UIFont.systemFont(ofSize: cell * 0.82, weight: .heavy, width: .condensed)
        let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: UIColor.white]
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = false
        var measured: [Character: CGFloat] = [:]
        let image = UIGraphicsImageRenderer(size: size, format: format).image { _ in
            for (i, ch) in Self.characters.enumerated() {
                let s = String(ch) as NSString
                let glyphSize = s.size(withAttributes: attributes)
                measured[ch] = glyphSize.width
                let x = CGFloat(i % cols) * cell + (cell - glyphSize.width) / 2
                let y = CGFloat(i / cols) * cell + (cell - glyphSize.height) / 2
                s.draw(at: CGPoint(x: x, y: y), withAttributes: attributes)
            }
        }
        guard let cg = image.cgImage else { return nil }
        let loader = MTKTextureLoader(device: device)
        guard let tex = try? loader.newTexture(cgImage: cg, options: [
            .SRGB: false,
            .generateMipmaps: true,
            .textureUsage: NSNumber(value: MTLTextureUsage.shaderRead.rawValue),
            .textureStorageMode: NSNumber(value: MTLStorageMode.private.rawValue),
        ]) else { return nil }
        texture = tex
        for (i, ch) in Self.characters.enumerated() {
            let w = measured[ch] ?? cell * 0.5
            let pad: CGFloat = 4
            let u0 = (CGFloat(i % cols) * cell + (cell - w) / 2 - pad) / size.width
            let v0 = (CGFloat(i / cols) * cell) / size.height
            glyphs[ch] = Glyph(uvOrigin: SIMD2(Float(u0), Float(v0)),
                               uvSize: SIMD2(Float((w + 2 * pad) / size.width), Float(cell / size.height)),
                               aspect: Float((w + 2 * pad) / cell))
        }
    }

    /// Glyph quads for a label centred at `center` with a given cell height, in view points.
    func layout(_ text: String, center: CGPoint, height: CGFloat, color: SIMD4<Float>) -> [GlyphInstance] {
        let items = text.compactMap { glyphs[$0] }
        let total = items.reduce(Float(0)) { $0 + $1.aspect } * Float(height) * 0.86
        var x = Float(center.x) - total / 2
        var out: [GlyphInstance] = []
        for g in items {
            let w = g.aspect * Float(height)
            out.append(GlyphInstance(origin: SIMD2(x - w * 0.07, Float(center.y) - Float(height) / 2),
                                     size: SIMD2(w, Float(height)), uvOrigin: g.uvOrigin, uvSize: g.uvSize, color: color))
            x += w * 0.86   // tight tracking for condensed numerals
        }
        return out
    }
}
