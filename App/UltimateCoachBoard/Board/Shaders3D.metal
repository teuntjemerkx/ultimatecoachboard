#include <metal_stdlib>
#include "ZoneShading.h"
using namespace metal;

// The 3D board (Section 3.2): world metres, Y up, the floor at y = 0. Colours leave premultiplied.

struct Scene3DUniforms {
    float4x4 viewProjection;
    float4 eye;          // xyz
    float4 light;        // xyz: direction toward the light; w: ambient
    // Template colours (rgb).
    float4 hall;
    float4 freeZone;
    float4 court;
    float4 lines;
    float4 tintA;
    float4 tintB;
    float4 skin;
    float4 shorts;
    float4 pads;
    float4 shoes;
    float4 hair;
    uint zoneCount;
    uint pad0, pad1, pad2;
};

// MARK: - Floor: navy hall, court, analytic court lines, zone grid and zones in one pass.

struct Floor3DOut {
    float4 position [[position]];
    float2 world;
};

vertex Floor3DOut floor3DVertex(uint vid [[vertex_id]], constant Scene3DUniforms &u [[buffer(1)]]) {
    float2 c = float2(vid & 1, vid >> 1);
    float2 w = float2(mix(-10.0, 10.0, c.x), mix(-17.0, 17.0, c.y));
    Floor3DOut o;
    o.position = u.viewProjection * float4(w.x, 0.0, w.y, 1.0);
    o.world = w;
    return o;
}

static inline float lineCoverage(float d, float halfWidth) {
    float aa = max(fwidth(d), 1e-5);
    float hw = max(halfWidth, aa * 0.5);
    return 1.0 - smoothstep(hw - aa, hw + aa, d);
}

static inline float crossLine(float2 w, float z) {
    return length(float2(max(abs(w.x) - 4.5, 0.0), w.y - z));
}

fragment float4 floor3DFragment(Floor3DOut in [[stage_in]],
                                const device ZoneGPU *zones [[buffer(0)]],
                                constant Scene3DUniforms &u [[buffer(1)]],
                                const device float2 *verts [[buffer(2)]]) {
    float2 w = in.world;
    float dCourt = sdBox(w, float2(4.5, 9.0));
    float dFree = sdBox(w, float2(7.5, 12.0));
    float aa = max(fwidth(dCourt), 1e-5);
    float3 col = mix(u.hall.rgb, u.freeZone.rgb, 1.0 - smoothstep(-aa, aa, dFree));
    col = mix(col, u.court.rgb, 1.0 - smoothstep(-aa, aa, dCourt));
    // Faint nine-zone grid (Micro-Scouting orientation aid).
    float grid = min(min(abs(abs(w.x) - 1.5), abs(abs(w.y) - 6.0)), 10.0);
    col = mix(col, float3(1.0), 0.06 * lineCoverage(grid, 0.012) * step(dCourt, 0.0));
    // Court lines, 5 cm: boundary, attack lines and centre line, in the template's line colour.
    float lines = min(abs(dCourt + 0.025), min(crossLine(w, 3.0), min(crossLine(w, -3.0), crossLine(w, 0.0))));
    col = mix(col, u.lines.rgb, u.lines.a * lineCoverage(lines, 0.025));
    float4 z = zoneColor(evaluateZones(w, zones, u.zoneCount, verts), u.tintA.rgb, u.tintB.rgb);
    col = col * (1.0 - z.a) + z.rgb;
    return float4(col, 1.0);
}

// MARK: - Patterned quads: the net mesh, tape, antennas, posts and floor ribbons (ink, attack lines, routes).

struct Quad3D {
    float4 origin;      // xyz
    float4 edgeU;       // xyz, w = length in metres
    float4 edgeV;       // xyz, w = length in metres
    float4 color;       // straight rgb + alpha
    uint pattern;       // 0 solid, 1 net mesh, 2 antenna stripes, 3 floor ring (player marker), 4 dashed
    uint pad0, pad1, pad2;
};

struct Quad3DOut {
    float4 position [[position]];
    float2 metres;
    float2 size;
    float4 color;
    uint pattern [[flat]];
};

vertex Quad3DOut quad3DVertex(uint vid [[vertex_id]], uint iid [[instance_id]],
                              const device Quad3D *quads [[buffer(0)]],
                              constant Scene3DUniforms &u [[buffer(1)]]) {
    Quad3D q = quads[iid];
    float2 c = float2(vid & 1, vid >> 1);
    float3 p = q.origin.xyz + q.edgeU.xyz * c.x + q.edgeV.xyz * c.y;
    Quad3DOut o;
    o.position = u.viewProjection * float4(p, 1.0);
    o.size = float2(q.edgeU.w, q.edgeV.w);
    o.metres = c * o.size;
    o.color = q.color;
    o.pattern = q.pattern;
    return o;
}

fragment float4 quad3DFragment(Quad3DOut in [[stage_in]]) {
    float a = in.color.a;
    float3 rgb = in.color.rgb;
    if (in.pattern == 1) {
        // 10 cm mesh squares with 8 mm cords.
        float2 g = abs(fract(in.metres / 0.1) - 0.5) * 0.1;
        float d = 0.05 - max(g.x, g.y);
        float aa = max(fwidth(d), 1e-5);
        float cords = 1.0 - smoothstep(0.004 - aa, 0.004 + aa, d);
        // Past the Nyquist limit the mesh fades to its average coverage instead of shimmering.
        a *= mix(cords, 0.22, smoothstep(0.012, 0.03, aa));
    } else if (in.pattern == 2) {
        // Antenna: 10 cm red and white bands.
        rgb = fract(in.metres.y / 0.2) < 0.5 ? float3(1.0, 0.23, 0.10) : float3(1.0);
    } else if (in.pattern == 3) {
        // Ring on the floor under a player: a 6 cm band on the quad's inscribed circle with a faint inner disc.
        float radius = 0.5 * min(in.size.x, in.size.y);
        float d = length(in.metres - 0.5 * in.size);
        float aa = max(fwidth(d), 1e-5);
        float band = 1.0 - smoothstep(0.03 - aa, 0.03 + aa, abs(d - (radius - 0.04)));
        float disc = 0.18 * (1.0 - smoothstep(radius - 0.04 - aa, radius - 0.04 + aa, d));
        a *= max(band, disc);
    } else if (in.pattern == 4) {
        // Dashes along the ribbon: 15 cm on, 10 cm off (occluded part of a gaze ray).
        a *= step(fract(in.metres.x / 0.25), 0.6);
    }
    return float4(rgb * a, a);
}

// MARK: - Avatars: procedural capsule meshes skinned with dual quaternions (two influences per vertex).

struct AvatarVertex {
    float4 position;    // rest pose, metres
    float4 normal;
    float4 skin;        // x, y: weights; z, w: joint indices
};

struct AvatarInstance {
    float4 color;       // jersey
    float4 rim;         // team colour of the fresnel rim
    uint dqOffset;      // first joint of this avatar in the dual-quaternion buffer
    uint selected;
    uint hideHead;      // POV: cull the viewer's own head and neck (Section 5.1)
    uint pad1;
};

struct AvatarOut {
    float4 position [[position]];
    float3 world;
    float3 normal;
    float4 color;
    float4 rim;
    uint material [[flat]];
    uint selected [[flat]];
};

vertex AvatarOut avatarVertex(uint vid [[vertex_id]], uint iid [[instance_id]],
                              const device AvatarVertex *verts [[buffer(0)]],
                              constant Scene3DUniforms &u [[buffer(1)]],
                              const device AvatarInstance *instances [[buffer(2)]],
                              const device float4 *dqs [[buffer(3)]]) {
    AvatarVertex v = verts[vid];
    AvatarInstance a = instances[iid];
    uint j0 = uint(v.skin.z), j1 = uint(v.skin.w);
    float4 r0 = dqs[(a.dqOffset + j0) * 2], d0 = dqs[(a.dqOffset + j0) * 2 + 1];
    float4 r1 = dqs[(a.dqOffset + j1) * 2], d1 = dqs[(a.dqOffset + j1) * 2 + 1];
    if (dot(r0, r1) < 0.0) { r1 = -r1; d1 = -d1; }
    float4 r = r0 * v.skin.x + r1 * v.skin.y;
    float4 d = d0 * v.skin.x + d1 * v.skin.y;
    float n = length(r);
    r /= n; d /= n;
    float3 p = v.position.xyz;
    float3 rotated = p + 2.0 * cross(r.xyz, cross(r.xyz, p) + r.w * p);
    float3 t = 2.0 * (r.w * d.xyz - d.w * r.xyz + cross(r.xyz, d.xyz));
    float3 nn = v.normal.xyz;
    AvatarOut o;
    o.world = rotated + t;
    o.normal = nn + 2.0 * cross(r.xyz, cross(r.xyz, nn) + r.w * nn);
    o.position = u.viewProjection * float4(o.world, 1.0);
    o.color = a.color;
    o.rim = a.rim;
    o.material = uint(v.normal.w + 0.5);
    o.selected = a.selected;
    // Joints 3 and 4 are the neck and head: outside the clip volume, so their triangles vanish.
    if (a.hideHead != 0 && (j0 == 3 || j0 == 4)) o.position = float4(2.0, 2.0, 2.0, 1.0);
    return o;
}

fragment float4 avatarFragment(AvatarOut in [[stage_in]], constant Scene3DUniforms &u [[buffer(1)]]) {
    float3 n = normalize(in.normal);
    float3 l = normalize(u.light.xyz);
    float3 v = normalize(u.eye.xyz - in.world);
    float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0);
    // Materials: 0 skin, 1 jersey (team colour), 2 shorts, 3 knee pads, 4 shoes, 5 hair, 6 socks.
    float3 base;
    switch (in.material) {
        case 1: base = in.color.rgb; break;
        case 2: base = u.shorts.rgb; break;
        case 3: base = u.pads.rgb; break;
        case 4: base = u.shoes.rgb; break;
        case 5: base = u.hair.rgb; break;
        case 6: base = mix(u.shoes.rgb, u.shorts.rgb, 0.12); break;
        default: base = u.skin.rgb; break;
    }
    // A soft wrap term keeps the shadow side readable on a dark floor.
    float wrap = saturate((dot(n, l) + 0.35) / 1.35);
    float3 col = base * (u.light.w + 0.8 * wrap) + in.rim.rgb * rim * (in.selected != 0 ? 1.2 : 0.45);
    return float4(col, 1.0);
}

// MARK: - Decals: SDF glyphs on world-space quads (jersey numbers).

struct Decal3D {
    float4 origin;
    float4 edgeU;
    float4 edgeV;
    float2 uvOrigin;
    float2 uvSize;
    float4 color;
};

struct DecalOut {
    float4 position [[position]];
    float2 uv;
    float4 color;
};

vertex DecalOut decalVertex(uint vid [[vertex_id]], uint iid [[instance_id]],
                            const device Decal3D *decals [[buffer(0)]],
                            constant Scene3DUniforms &u [[buffer(1)]]) {
    Decal3D d = decals[iid];
    float2 c = float2(vid & 1, vid >> 1);
    float3 p = d.origin.xyz + d.edgeU.xyz * c.x + d.edgeV.xyz * c.y;
    DecalOut o;
    o.position = u.viewProjection * float4(p, 1.0);
    // Atlas rows run top-down; the quad's v runs up.
    o.uv = d.uvOrigin + float2(c.x, 1.0 - c.y) * d.uvSize;
    o.color = d.color;
    return o;
}

fragment float4 decalFragment(DecalOut in [[stage_in]], texture2d<float> atlas [[texture(0)]]) {
    constexpr sampler s(filter::linear, address::clamp_to_edge);
    float d = atlas.sample(s, in.uv).r;
    float w = max(fwidth(d) * 0.75, 1e-4);
    float a = in.color.a * smoothstep(0.5 - w, 0.5 + w, d);
    return float4(in.color.rgb * a, a);
}

// MARK: - Zone walls and cylinders (Section 3.5.5): opacity falls with height, a bright line on top, additive.

struct WallVertex {
    float4 position;    // xyz, w = height fraction 0...1
    float4 color;       // straight rgb + base opacity
};

struct WallOut {
    float4 position [[position]];
    float v;
    float4 color;
};

vertex WallOut wallVertex(uint vid [[vertex_id]], const device WallVertex *verts [[buffer(0)]],
                          constant Scene3DUniforms &u [[buffer(1)]]) {
    WallVertex w = verts[vid];
    WallOut o;
    o.position = u.viewProjection * float4(w.position.xyz, 1.0);
    o.v = w.position.w;
    o.color = w.color;
    return o;
}

fragment float4 wallFragment(WallOut in [[stage_in]]) {
    float a = in.color.a * pow(saturate(1.0 - in.v), 1.8);
    float aa = max(fwidth(in.v), 1e-5);
    float top = smoothstep(0.96 - aa, 0.96 + aa, in.v);               // thin bright line at the top edge
    a = max(a, top * 0.9);
    return float4(in.color.rgb * a, a);
}

// MARK: - Hall from a video: the clean background plate projected through the video camera (Section 4.10).

struct EnvUniforms {
    float4x4 worldToImage;
    float4 fallback;     // rgb: never seen; a: plate brightness
    float4 box;          // half width, half length, height
};

struct EnvOut {
    float4 position [[position]];
    float3 world;
};

vertex EnvOut envVertex(uint vid [[vertex_id]], const device float4 *verts [[buffer(0)]],
                        constant Scene3DUniforms &u [[buffer(1)]]) {
    EnvOut o;
    float3 p = verts[vid].xyz;
    o.world = p;
    o.position = u.viewProjection * float4(p, 1.0);
    return o;
}

static inline bool plateUV(float3 p, float4x4 m, thread float2 &uv) {
    float4 q = m * float4(p, 1.0);
    if (q.w <= 1e-4) return false;
    uv = q.xy / q.w;
    return uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0;
}

// Where the video saw the wall, its pixels; where it did not, the mirror image across the court's middle
// (halls are close to symmetric), slightly darker; otherwise the hall colour, darkening toward the ceiling.
fragment float4 envFragment(EnvOut in [[stage_in]], constant EnvUniforms &e [[buffer(0)]],
                            texture2d<float> plate [[texture(0)]]) {
    constexpr sampler s(filter::linear, address::clamp_to_edge);
    float3 p = in.world;
    float3 tries[4] = { p, float3(-p.x, p.y, p.z), float3(p.x, p.y, -p.z), float3(-p.x, p.y, -p.z) };
    for (int i = 0; i < 4; i++) {
        float2 uv;
        if (plateUV(tries[i], e.worldToImage, uv)) {
            float3 c = plate.sample(s, uv).rgb * e.fallback.a * (i == 0 ? 1.0 : 0.82);
            return float4(c, 1.0);
        }
    }
    float h = saturate(p.y / max(e.box.z, 1.0));
    return float4(e.fallback.rgb * (1.0 - 0.35 * h), 1.0);
}
