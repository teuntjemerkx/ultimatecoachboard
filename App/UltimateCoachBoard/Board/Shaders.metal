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
