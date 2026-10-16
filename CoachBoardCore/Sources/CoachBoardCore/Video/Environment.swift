import Foundation

/// The empty hall behind the players (Section 4.5): a temporal median over sampled frames removes everything that
/// moves (players, ball), leaving the court, the walls and the stands as one still image.
public enum CleanPlate {
    /// Per-pixel, per-channel temporal median of the unmasked samples. `frames` are RGBA8 images of `width` x
    /// `height` (row-major, 4 bytes per pixel); `masks`, when given, hold one byte per pixel per frame, non-zero where a
    /// person is (those samples are ignored). Pixels never seen unmasked take the colour of the nearest seen pixel in
    /// their row or column (ties prefer the row, then left and up; repeated until filled). Alpha is 255. Frames or
    /// masks of the wrong size are skipped.
    public static func median(frames: [[UInt8]], masks: [[UInt8]]? = nil, width: Int, height: Int) -> [UInt8] {
        let pixels = width * height
        var out = [UInt8](repeating: 0, count: max(pixels, 0) * 4)
        let usable = frames.indices.filter { frames[$0].count >= pixels * 4 }
        let n = usable.count
        guard pixels > 0, n > 0 else { return out }
        var counts = [Int](repeating: 0, count: pixels)
        var samples = [UInt8](repeating: 0, count: pixels * n)
        var valid = [Bool](repeating: false, count: pixels)
        for channel in 0..<3 {
            counts.withUnsafeMutableBufferPointer { cnt in
                for i in 0..<pixels { cnt[i] = 0 }
                samples.withUnsafeMutableBufferPointer { s in
                    for k in usable {
                        let mask = masks.flatMap { k < $0.count && $0[k].count >= pixels ? $0[k] : nil }
                        frames[k].withUnsafeBufferPointer { f in
                            if let mask {
                                mask.withUnsafeBufferPointer { m in
                                    for i in 0..<pixels where m[i] == 0 {
                                        s[i * n + cnt[i]] = f[i * 4 + channel]
                                        cnt[i] += 1
                                    }
                                }
                            } else {
                                for i in 0..<pixels {
                                    s[i * n + cnt[i]] = f[i * 4 + channel]
                                    cnt[i] += 1
                                }
                            }
                        }
                    }
                    out.withUnsafeMutableBufferPointer { o in
                        valid.withUnsafeMutableBufferPointer { v in
                            guard let base = s.baseAddress else { return }
                            for i in 0..<pixels {
                                let m = cnt[i]
                                guard m > 0 else { continue }
                                v[i] = true
                                o[i * 4 + channel] = medianInPlace(base + i * n, m)
                            }
                        }
                    }
                }
            }
        }
        fill(&out, valid: valid, width: width, height: height)
        for i in 0..<pixels { out[i * 4 + 3] = 255 }
        return out
    }

    /// The median of `count` bytes (the mean of the two middle ones for an even count), reordering them.
    static func medianInPlace(_ a: UnsafeMutablePointer<UInt8>, _ count: Int) -> UInt8 {
        let k = (count - 1) / 2
        let lower = select(a, count, k)
        guard count % 2 == 0 else { return lower }
        // Everything after k is >= a[k]: the upper middle is the smallest of them.
        var upper = UInt8.max
        for i in (k + 1)..<count where a[i] < upper { upper = a[i] }
        return UInt8((Int(lower) + Int(upper) + 1) / 2)
    }

    /// Hoare's selection: the k-th smallest of `count` bytes, leaving smaller ones before and larger ones after it.
    static func select(_ a: UnsafeMutablePointer<UInt8>, _ count: Int, _ k: Int) -> UInt8 {
        var lo = 0, hi = count - 1
        while lo < hi {
            let pivot = a[(lo + hi) >> 1]
            var i = lo, j = hi
            while i <= j {
                while a[i] < pivot { i += 1 }
                while a[j] > pivot { j -= 1 }
                if i <= j {
                    let t = a[i]; a[i] = a[j]; a[j] = t
                    i += 1
                    j -= 1
                }
            }
            if k <= j { hi = j } else if k >= i { lo = i } else { return a[k] }
        }
        return a[k]
    }

    /// Fills invalid pixels from the nearest valid one along their row or column.
    static func fill(_ img: inout [UInt8], valid input: [Bool], width w: Int, height h: Int) {
        var valid = input
        guard valid.contains(true) else { return }
        while valid.contains(false) {
            var source = [Int](repeating: -1, count: w * h), distance = [Int](repeating: Int.max, count: w * h)
            func consider(_ i: Int, _ from: Int, _ d: Int) {
                if d < distance[i] { distance[i] = d; source[i] = from }
            }
            for y in 0..<h {
                var last = -1
                for x in 0..<w {
                    let i = y * w + x
                    if valid[i] { last = x } else if last >= 0 { consider(i, y * w + last, x - last) }
                }
                last = -1
                for x in stride(from: w - 1, through: 0, by: -1) {
                    let i = y * w + x
                    if valid[i] { last = x } else if last >= 0 { consider(i, y * w + last, last - x) }
                }
            }
            for x in 0..<w {
                var last = -1
                for y in 0..<h {
                    let i = y * w + x
                    if valid[i] { last = y } else if last >= 0 { consider(i, last * w + x, y - last) }
                }
                last = -1
                for y in stride(from: h - 1, through: 0, by: -1) {
                    let i = y * w + x
                    if valid[i] { last = y } else if last >= 0 { consider(i, last * w + x, last - y) }
                }
            }
            var progress = false
            for i in 0..<(w * h) where !valid[i] && source[i] >= 0 {
                let s = source[i]
                img[i * 4] = img[s * 4]
                img[i * 4 + 1] = img[s * 4 + 1]
                img[i * 4 + 2] = img[s * 4 + 2]
                progress = true
            }
            guard progress else { return }
            for i in 0..<(w * h) where source[i] >= 0 { valid[i] = true }
        }
    }
}

/// The hall around the court as a box (Section 4.5), textured from the clean plate so a POV camera anywhere on court
/// sees the real hall. The floor (y = 0) extends beyond the court lines to the walls; the walls stand `sideClearance`
/// beyond the sidelines and `endClearance` beyond the end lines; the ceiling is at `height`.
///
/// Texturing, for the renderer's shader: a point p on the box is looked up in the video frame through the calibrated
/// camera, `c = R (p - C)`, `u = (f c.x / c.z + w / 2) / w`, `v = (f c.y / c.z + h / 2) / h` (v down, 0...1), which is
/// `normalizedProjection` applied to (p, 1) followed by the divide by its third component. The lookup is valid when
/// `c.z > 0` and u, v lie in 0...1. Otherwise the hall is assumed symmetric and the same test is repeated for p
/// mirrored across X = 0, then across Z = 0, then both (a 180-degree turn); a mirrored hit is flagged so the shader
/// can dim it. With no hit the shader falls back to a neutral wall colour.
public struct HallEnvironment: Hashable, Codable, Sendable {
    public var sideClearance: Double
    public var endClearance: Double
    public var height: Double

    public init(sideClearance: Double = 7, endClearance: Double = 8, height: Double = 10) {
        self.sideClearance = sideClearance
        self.endClearance = endClearance
        self.height = height
    }

    /// Half extents of the box: walls at x = +-halfWidth and z = +-halfLength.
    public var halfWidth: Double { CourtFrame.halfWidth + sideClearance }
    public var halfLength: Double { 9 + endClearance }

    public func contains(_ p: V3) -> Bool {
        abs(p.x) <= halfWidth && abs(p.z) <= halfLength && p.y >= 0 && p.y <= height
    }

    /// Where a ray from a point inside the hall leaves it (floor, a wall or the ceiling): what the POV camera sees in
    /// that direction behind everything modelled. Nil when the origin is outside.
    public func exitPoint(from o: V3, direction d: V3) -> V3? {
        guard contains(o) else { return nil }
        var t = Double.infinity
        func face(_ o: Double, _ d: Double, _ lo: Double, _ hi: Double) {
            if d > 1e-12 { t = min(t, (hi - o) / d) } else if d < -1e-12 { t = min(t, (lo - o) / d) }
        }
        face(o.x, d.x, -halfWidth, halfWidth)
        face(o.y, d.y, 0, height)
        face(o.z, d.z, -halfLength, halfLength)
        return t.isFinite ? o + d * t : nil
    }

    /// The video-frame coordinates (0...1, v down) that texture a world point, trying the point itself, then its
    /// mirror images across X = 0, Z = 0 and both; `mirrored` is set when a mirror image was used. Nil when none is
    /// in the frame. `margin` shrinks the usable frame (normalised units) to avoid sampling the very edge.
    public func uv(for p: V3, camera: VideoCamera, margin: Double = 0) -> (u: Double, v: Double, mirrored: Bool)? {
        let candidates = [(p, false), (V3(-p.x, p.y, p.z), true), (V3(p.x, p.y, -p.z), true), (V3(-p.x, p.y, -p.z), true)]
        for (q, mirrored) in candidates {
            let c = camera.cameraCoordinates(q)
            guard c.z > 0.05 else { continue }
            let u = (camera.focalLength * c.x / c.z + camera.width / 2) / camera.width
            let v = (camera.focalLength * c.y / c.z + camera.height / 2) / camera.height
            if u >= margin && u <= 1 - margin && v >= margin && v <= 1 - margin { return (u, v, mirrored) }
        }
        return nil
    }
}

extension VideoCamera {
    /// The 3 x 4 matrix taking homogeneous world points to normalised frame coordinates (u, v in 0...1, v down) before
    /// the perspective divide, row-major: diag(f / w, f / h, 1) with the principal point at 0.5, times [R | -R C].
    /// This is what a shader needs to texture world geometry from the video or the clean plate.
    public var normalizedProjection: [Double] {
        let r = matrix
        let t = -(r * center)
        let k0 = V3(focalLength / width, 0, 0.5), k1 = V3(0, focalLength / height, 0.5), k2 = V3(0, 0, 1)
        var out: [Double] = []
        for k in [k0, k1, k2] {
            let row = r.transpose * k        // k^T R as a column
            out += [row.x, row.y, row.z, k.dot(t)]
        }
        return out
    }
}
