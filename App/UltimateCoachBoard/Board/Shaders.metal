#include <metal_stdlib>
using namespace metal;

// All geometry is expressed in view points; the vertex stage converts to NDC.
// Colours arrive straight (non-premultiplied) and leave premultiplied for one/oneMinusSrcAlpha blending.

struct Uniforms {
    float2 viewSize;
};

static inline float4 toNDC(float2 p, float2 size) {
    return float4(p.x / size.x * 2.0 - 1.0, 1.0 - p.y / size.y * 2.0, 0.0, 1.0);
}

// MARK: - Segments (court lines, vectors, tethers, ink): capsule SDF with optional dashes

struct SegmentInstance {
    float2 p0;
    float2 p1;
    float halfWidth;
    float dash;
    float gap;
    float pad;
    float4 color;
};

struct SegmentOut {
    float4 position [[position]];
    float2 local;
    float2 p0;
    float2 p1;
    float halfWidth;
    float dash;
    float gap;
    float4 color;
};

vertex SegmentOut segmentVertex(uint vid [[vertex_id]], uint iid [[instance_id]],
                                const device SegmentInstance *instances [[buffer(0)]],
                                constant Uniforms &u [[buffer(1)]]) {
    SegmentInstance s = instances[iid];
    float2 dir = s.p1 - s.p0;
    float len = length(dir);
    float2 d = len > 1e-4 ? dir / len : float2(1.0, 0.0);
    float2 n = float2(-d.y, d.x);
    float r = s.halfWidth + 1.5;
    float2 corners[4] = { s.p0 - d * r - n * r, s.p1 + d * r - n * r, s.p0 - d * r + n * r, s.p1 + d * r + n * r };
    float2 p = corners[vid];
    SegmentOut o;
    o.position = toNDC(p, u.viewSize);
    o.local = p;
    o.p0 = s.p0;
    o.p1 = s.p1;
    o.halfWidth = s.halfWidth;
    o.dash = s.dash;
    o.gap = s.gap;
    o.color = s.color;
    return o;
}

fragment float4 segmentFragment(SegmentOut in [[stage_in]]) {
    float2 pa = in.local - in.p0;
    float2 ba = in.p1 - in.p0;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
    float dist = length(pa - ba * h) - in.halfWidth;
    float aa = max(fwidth(dist), 0.5);
    float alpha = 1.0 - smoothstep(-aa, aa, dist);
    if (in.dash > 0.0) {
        float along = h * length(ba);
        float m = fmod(along, in.dash + in.gap);
        alpha *= 1.0 - smoothstep(in.dash - aa, in.dash + aa, m);
    }
    float a = in.color.a * alpha;
    return float4(in.color.rgb * a, a);
}

// MARK: - Tokens: circle (home) or diamond (opponent) rings with a navy interior

struct TokenInstance {
    float2 center;
    float radius;
    float ring;
    float shape;      // 0 = circle, 1 = diamond
    float glow;       // 0...1 selection halo
    float2 pad;
    float4 fill;
    float4 ringColor;
};

struct TokenOut {
    float4 position [[position]];
    float2 local;
    float radius;
    float ring;
    float shape;
    float glow;
    float4 fill;
    float4 ringColor;
};

vertex TokenOut tokenVertex(uint vid [[vertex_id]], uint iid [[instance_id]],
                            const device TokenInstance *instances [[buffer(0)]],
                            constant Uniforms &u [[buffer(1)]]) {
    TokenInstance t = instances[iid];
    float extent = t.radius * (t.shape > 0.5 ? 1.45 : 1.0) + 10.0;
    float2 offsets[4] = { float2(-1, -1), float2(1, -1), float2(-1, 1), float2(1, 1) };
    float2 local = offsets[vid] * extent;
    TokenOut o;
    o.position = toNDC(t.center + local, u.viewSize);
    o.local = local;
    o.radius = t.radius;
    o.ring = t.ring;
    o.shape = t.shape;
    o.glow = t.glow;
    o.fill = t.fill;
    o.ringColor = t.ringColor;
    return o;
}

fragment float4 tokenFragment(TokenOut in [[stage_in]]) {
    float d;
    if (in.shape > 0.5) {
        // Diamond of equal area to the circle: vertex distance r * sqrt(pi / 2).
        float rv = in.radius * 1.2533;
        d = (abs(in.local.x) + abs(in.local.y) - rv) * 0.70710678;
    } else {
        d = length(in.local) - in.radius;
    }
    float aa = max(fwidth(d), 0.5);
    float inside = 1.0 - smoothstep(-aa, aa, d);
    float ringMask = 1.0 - smoothstep(-aa, aa, abs(d + in.ring * 0.5) - in.ring * 0.5);
    float halo = in.glow * exp(-max(d, 0.0) / 4.0) * (1.0 - inside) * 0.6;
    float4 fill = in.fill * inside;
    float4 ring = in.ringColor * ringMask;
    float a = max(max(fill.a, ring.a), in.ringColor.a * halo);
    float3 rgb = mix(in.fill.rgb, in.ringColor.rgb, ringMask > 0.0 ? ringMask : (halo > 0.0 ? 1.0 : 0.0));
    return float4(rgb * a, a);
}

// MARK: - Glyphs from the jersey-number atlas

struct GlyphInstance {
    float2 origin;
    float2 size;
    float2 uvOrigin;
    float2 uvSize;
    float4 color;
};

struct GlyphOut {
    float4 position [[position]];
    float2 uv;
    float4 color;
};

vertex GlyphOut glyphVertex(uint vid [[vertex_id]], uint iid [[instance_id]],
                            const device GlyphInstance *instances [[buffer(0)]],
                            constant Uniforms &u [[buffer(1)]]) {
    GlyphInstance g = instances[iid];
    float2 corner = float2(vid & 1, vid >> 1);
    GlyphOut o;
    o.position = toNDC(g.origin + corner * g.size, u.viewSize);
    o.uv = g.uvOrigin + corner * g.uvSize;
    o.color = g.color;
    return o;
}

// Signed distance field glyphs: 0.5 is the edge; fwidth keeps the antialiased band one pixel wide at any scale.
fragment float4 glyphFragment(GlyphOut in [[stage_in]], texture2d<float> atlas [[texture(0)]]) {
    constexpr sampler s(filter::linear, address::clamp_to_edge);
    float d = atlas.sample(s, in.uv).r;
    float w = max(fwidth(d) * 0.75, 1e-4);
    float coverage = smoothstep(0.5 - w, 0.5 + w, d);
    float a = in.color.a * coverage;
    return float4(in.color.rgb * a, a);
}

// MARK: - Hatched regions (Legal Envelope in Phase 1; the SDF zone engine generalizes this in Phase 2)

struct HatchInstance {
    float2 center;
    float2 halfSize;
    float angle;
    float spacing;
    float lineWidth;
    float pad;
    float4 color;
};

struct HatchOut {
    float4 position [[position]];
    float2 local;
    float2 halfSize;
    float angle;
    float spacing;
    float lineWidth;
    float4 color;
};

vertex HatchOut hatchVertex(uint vid [[vertex_id]], uint iid [[instance_id]],
                            const device HatchInstance *instances [[buffer(0)]],
                            constant Uniforms &u [[buffer(1)]]) {
    HatchInstance h = instances[iid];
    float2 offsets[4] = { float2(-1, -1), float2(1, -1), float2(-1, 1), float2(1, 1) };
    float2 local = offsets[vid] * (h.halfSize + 2.0);
    HatchOut o;
    o.position = toNDC(h.center + local, u.viewSize);
    o.local = local;
    o.halfSize = h.halfSize;
    o.angle = h.angle;
    o.spacing = h.spacing;
    o.lineWidth = h.lineWidth;
    o.color = h.color;
    return o;
}

fragment float4 hatchFragment(HatchOut in [[stage_in]]) {
    float2 q = abs(in.local) - in.halfSize;
    float box = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
    float aa = max(fwidth(box), 0.5);
    float inside = 1.0 - smoothstep(-aa, aa, box);
    float edge = 1.0 - smoothstep(-aa, aa, abs(box) - 0.75);
    float u = dot(in.local, float2(cos(in.angle), sin(in.angle))) / in.spacing;
    float fu = max(fwidth(u), 1e-4);
    float qd = abs(fract(u) - 0.5);
    float hw = 0.5 * in.lineWidth / in.spacing;
    float line = 1.0 - smoothstep(hw - fu, hw + fu, qd);
    line = mix(line, in.lineWidth / in.spacing, saturate((fu - 0.25) * 4.0));
    float a = in.color.a * max(line * inside, edge);
    return float4(in.color.rgb * a, a);
}

// MARK: - Zone floor pass (Section 3.5.4): every zone evaluated per fragment as an exact signed distance field,
// with patterns in court metres, analytic anti-aliasing, a Nyquist fade and composition by maximum per tint.

struct ZoneGPU {
    uint kind;          // 0 rect, 1 circle, 2 ellipse, 3 polygon (freeforms arrive tessellated)
    uint pattern;       // 0 cross-hatch, 1 diagonal, 2 dots, 3 glow fill, 4 outline
    uint vertexOffset;
    uint vertexCount;
    float4 toLocal0;    // local.x = dot(toLocal0.xy, world) + toLocal0.z
    float4 toLocal1;    // local.y = dot(toLocal1.xy, world) + toLocal1.z
    float4 params;      // rect: half extents; circle: radius; ellipse: semi-axes
    float4 color;       // rgb unused (tint decides), a = opacity
    float spacing;
    float lineWidth;
    float angle;
    float glow;
    uint dashed;
    uint selected;
    uint tint;          // 0 pink, 1 cyan
    uint pad;
};

struct FloorUniforms {
    float2 viewSize;
    float2 center;
    float scale;
    uint flipped;
    uint zoneCount;
    uint pad;
};

struct FloorOut {
    float4 position [[position]];
    float2 viewPoint;
};

vertex FloorOut floorVertex(uint vid [[vertex_id]], constant FloorUniforms &u [[buffer(1)]]) {
    float2 corner = float2(vid & 1, vid >> 1);
    FloorOut o;
    o.viewPoint = corner * u.viewSize;
    o.position = toNDC(o.viewPoint, u.viewSize);
    return o;
}

static inline float sdBox(float2 p, float2 b) {
    float2 d = abs(p) - b;
    return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

// Inigo Quilez's closed-form ellipse distance.
static inline float sdEllipse(float2 p, float2 ab) {
    if (abs(ab.x - ab.y) < 1e-4) return length(p) - ab.x;
    p = abs(p);
    if (p.x > p.y) { p = p.yx; ab = ab.yx; }
    float l = ab.y * ab.y - ab.x * ab.x;
    float m = ab.x * p.x / l, m2 = m * m;
    float n = ab.y * p.y / l, n2 = n * n;
    float c = (m2 + n2 - 1.0) / 3.0, c3 = c * c * c;
    float q = c3 + m2 * n2 * 2.0;
    float d = c3 + m2 * n2;
    float g = m + m * n2;
    float co;
    if (d < 0.0) {
        float h = acos(clamp(q / c3, -1.0, 1.0)) / 3.0;
        float s = cos(h), t = sin(h) * sqrt(3.0);
        float rx = sqrt(max(-c * (s + t + 2.0) + m2, 0.0));
        float ry = sqrt(max(-c * (s - t + 2.0) + m2, 0.0));
        co = (ry + sign(l) * rx + abs(g) / max(rx * ry, 1e-12) - m) / 2.0;
    } else {
        float h = 2.0 * m * n * sqrt(d);
        float s = sign(q + h) * pow(abs(q + h), 1.0 / 3.0);
        float u = sign(q - h) * pow(abs(q - h), 1.0 / 3.0);
        float rx = -s - u - c * 4.0 + 2.0 * m2;
        float ry = (s - u) * sqrt(3.0);
        float rm = sqrt(rx * rx + ry * ry);
        co = (ry / max(sqrt(rm - rx), 1e-12) + 2.0 * g / max(rm, 1e-12) - m) / 2.0;
    }
    co = clamp(co, -1.0, 1.0);
    float2 r = ab * float2(co, sqrt(1.0 - co * co));
    return length(r - p) * sign(p.y - r.y);
}

static inline float sdPolygon(float2 p, const device float2 *v, uint off, uint n) {
    float d = dot(p - v[off], p - v[off]);
    float s = 1.0;
    for (uint i = 0, j = n - 1; i < n; j = i, i++) {
        float2 vi = v[off + i], vj = v[off + j];
        float2 e = vj - vi, w = p - vi;
        float2 b = w - e * clamp(dot(w, e) / max(dot(e, e), 1e-12), 0.0, 1.0);
        d = min(d, dot(b, b));
        bool3 c = bool3(p.y >= vi.y, p.y < vj.y, e.x * w.y > e.y * w.x);
        if (all(c) || all(!c)) s = -s;
    }
    return s * sqrt(d);
}

// Hatch lines every `spacing` metres along `angle`, at least one pixel wide; beyond the Nyquist limit the pattern
// fades to its mean coverage (line width over spacing), so it never shimmers.
static inline float zoneHatch(float2 p, float angle, float spacing, float width) {
    float u = dot(p, float2(cos(angle), sin(angle))) / spacing;
    float aa = max(fwidth(u), 1e-5);
    float q = abs(fract(u) - 0.5);
    float hw = max(0.5 * width / spacing, 0.5 * aa);
    float line = 1.0 - smoothstep(hw - aa, hw + aa, q);
    float mean = min(width / spacing, 1.0);
    return mix(line, mean, saturate((aa - 0.25) * 4.0));
}

static inline float zoneDots(float2 p, float spacing, float radius) {
    float2 cell = (fract(p / spacing) - 0.5) * spacing;
    float d = length(cell) - radius;
    float aa = max(fwidth(d), 1e-5);
    float disc = 1.0 - smoothstep(-aa, aa, d);
    float mean = M_PI_F * radius * radius / (spacing * spacing);
    return mix(disc, mean, saturate((fwidth(p.x / spacing) - 0.25) * 4.0));
}

fragment float4 zoneFragment(FloorOut in [[stage_in]],
                             const device ZoneGPU *zones [[buffer(0)]],
                             constant FloorUniforms &u [[buffer(1)]],
                             const device float2 *verts [[buffer(2)]]) {
    float2 vp = in.viewPoint;
    float2 w = u.flipped == 0 ? float2((vp.y - u.center.y) / u.scale, (u.center.x - vp.x) / u.scale)
                              : float2((u.center.y - vp.y) / u.scale, (vp.x - u.center.x) / u.scale);
    float pink = 0.0, cyan = 0.0;
    for (uint i = 0; i < u.zoneCount; i++) {
        ZoneGPU z = zones[i];
        float2 p = float2(dot(z.toLocal0.xy, w) + z.toLocal0.z, dot(z.toLocal1.xy, w) + z.toLocal1.z);
        float d;
        if (z.kind == 0) d = sdBox(p, z.params.xy);
        else if (z.kind == 1) d = length(p) - z.params.x;
        else if (z.kind == 2) d = sdEllipse(p, z.params.xy);
        else d = sdPolygon(w, verts, z.vertexOffset, z.vertexCount);
        float aa = max(fwidth(d), 1e-5);
        float inside = 1.0 - smoothstep(-aa, aa, d);
        float pattern;
        if (z.pattern == 0) pattern = max(zoneHatch(w, z.angle, z.spacing, z.lineWidth),
                                          zoneHatch(w, z.angle + M_PI_2_F, z.spacing, z.lineWidth));
        else if (z.pattern == 1) pattern = zoneHatch(w, z.angle, z.spacing, z.lineWidth);
        else if (z.pattern == 2) pattern = zoneDots(w, z.spacing, z.spacing * 0.2);
        else if (z.pattern == 3) pattern = 0.15 + 0.85 * exp(-3.0 * abs(d));
        else pattern = 0.0;
        float fill = inside * pattern * z.color.a;
        float halfLine = max(z.lineWidth * (z.selected != 0 ? 2.0 : 1.0), aa);
        float edge = 1.0 - smoothstep(halfLine - aa, halfLine + aa, abs(d));
        if (z.dashed != 0) edge *= step(fract(dot(w, float2(0.7071, 0.7071)) / 0.4), 0.6);
        edge *= min(1.0, z.color.a + 0.45);
        float halo = d > 0.0 ? z.glow * 0.35 * exp(-d * 9.0) : 0.0;
        float a = max(max(fill, edge), halo);
        if (z.selected != 0) a = max(a, inside * 0.14);
        if (z.tint == 0) pink = max(pink, a); else cyan = max(cyan, a);
    }
    float alpha = saturate(max(pink, cyan));
    float3 rgb = float3(1.0, 0.0, 0.498) * pink + float3(0.0, 0.941, 1.0) * cyan;
    return float4(min(rgb, float3(alpha)), alpha);
}
