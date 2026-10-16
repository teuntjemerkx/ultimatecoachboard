import Foundation

/// Signed distance fields for crisp glyphs and shapes at any scale (blueprint Section 3.2).
/// Exact Euclidean distances by the separable transform of Felzenszwalb and Huttenlocher.
public enum SignedDistance {
    private static let far: Float = 1e20

    /// Squared Euclidean distance to the nearest feature pixel (where `feature` is true), per pixel.
    public static func squaredDistance(feature: [Bool], width: Int, height: Int) -> [Float] {
        precondition(feature.count == width * height, "mask size")
        var f = feature.map { $0 ? Float(0) : far }
        let n = max(width, height)
        var line = [Float](repeating: 0, count: n)
        var out = [Float](repeating: 0, count: n)
        var v = [Int](repeating: 0, count: n)
        var z = [Float](repeating: 0, count: n + 1)
        for x in 0..<width {
            for y in 0..<height { line[y] = f[y * width + x] }
            transform1D(line, height, &out, &v, &z)
            for y in 0..<height { f[y * width + x] = out[y] }
        }
        for y in 0..<height {
            for x in 0..<width { line[x] = f[y * width + x] }
            transform1D(line, width, &out, &v, &z)
            for x in 0..<width { f[y * width + x] = out[x] }
        }
        return f
    }

    /// Lower envelope of parabolas rooted at each sample (one dimension of the exact transform).
    private static func transform1D(_ f: [Float], _ n: Int, _ d: inout [Float], _ v: inout [Int], _ z: inout [Float]) {
        guard n > 0 else { return }
        var k = 0
        v[0] = 0
        z[0] = -.infinity
        z[1] = .infinity
        if n > 1 {
            for q in 1..<n {
                var s: Float
                repeat {
                    let p = v[k]
                    s = ((f[q] + Float(q * q)) - (f[p] + Float(p * p))) / Float(2 * (q - p))
                    if s <= z[k] { k -= 1 } else { break }
                } while true
                k += 1
                v[k] = q
                z[k] = s
                z[k + 1] = .infinity
            }
        }
        k = 0
        for q in 0..<n {
            while z[k + 1] < Float(q) { k += 1 }
            let dq = Float(q - v[k])
            d[q] = dq * dq + f[v[k]]
        }
    }

    /// An 8-bit signed distance field from 8-bit coverage: 128 is the edge, larger values are inside,
    /// and `spread` pixels of distance map to the full range on each side.
    public static func field(coverage: [UInt8], width: Int, height: Int, spread: Float) -> [UInt8] {
        let inside = coverage.map { $0 >= 128 }
        let toInside = squaredDistance(feature: inside, width: width, height: height)
        let toOutside = squaredDistance(feature: inside.map { !$0 }, width: width, height: height)
        var out = [UInt8](repeating: 0, count: width * height)
        for i in 0..<out.count {
            // Half a pixel shifts both distances onto the edge between the pixel centres.
            let signed = inside[i] ? (toOutside[i].squareRoot() - 0.5) : -(toInside[i].squareRoot() - 0.5)
            let value = 0.5 + signed / (2 * spread)
            out[i] = UInt8(max(0, min(255, (value * 255).rounded())))
        }
        return out
    }
}
