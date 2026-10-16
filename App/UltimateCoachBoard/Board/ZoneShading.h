#ifndef ZONE_SHADING_H
#define ZONE_SHADING_H
#include <metal_stdlib>
using namespace metal;

// Zone shading shared by the 2D and 3D floor passes (Section 3.5.4): exact signed distances, patterns in court
// metres with analytic anti-aliasing and a Nyquist fade, composition by maximum per tint.

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
    float intensity;    // keyframed style intensity (Section 3.5.7), scales the whole zone
    // Type-change morph: a second shape whose signed distance blends in, d = mix(d0, d1, blend).
    uint kind2;
    uint vertexOffset2;
    uint vertexCount2;
    float blend;
    float4 toLocal2_0;
    float4 toLocal2_1;
    float4 params2;
};

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

static inline float zoneShapeDistance(float2 w, uint kind, float4 l0, float4 l1, float4 params,
                                      const device float2 *verts, uint offset, uint count) {
    float2 p = float2(dot(l0.xy, w) + l0.z, dot(l1.xy, w) + l1.z);
    if (kind == 0) return sdBox(p, params.xy);
    if (kind == 1) return length(p) - params.x;
    if (kind == 2) return sdEllipse(p, params.xy);
    return sdPolygon(w, verts, offset, count);
}

// Coverage of every zone at world floor point w: x = pink, y = cyan (maximum per tint).
static inline float2 evaluateZones(float2 w, const device ZoneGPU *zones, uint count, const device float2 *verts) {
    float pink = 0.0, cyan = 0.0;
    for (uint i = 0; i < count; i++) {
        ZoneGPU z = zones[i];
        if (z.intensity <= 0.001) continue;
        float d = zoneShapeDistance(w, z.kind, z.toLocal0, z.toLocal1, z.params, verts, z.vertexOffset, z.vertexCount);
        if (z.blend > 0.0) {
            float d2 = zoneShapeDistance(w, z.kind2, z.toLocal2_0, z.toLocal2_1, z.params2, verts, z.vertexOffset2, z.vertexCount2);
            d = mix(d, d2, z.blend);
        }
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
        a *= z.intensity;
        if (z.tint == 0) pink = max(pink, a); else cyan = max(cyan, a);
    }
    return float2(pink, cyan);
}

// Premultiplied colour of the zone coverage.
static inline float4 zoneColor(float2 cov) {
    float alpha = saturate(max(cov.x, cov.y));
    float3 rgb = float3(1.0, 0.0, 0.498) * cov.x + float3(0.0, 0.941, 1.0) * cov.y;
    return float4(min(rgb, float3(alpha)), alpha);
}

#endif
