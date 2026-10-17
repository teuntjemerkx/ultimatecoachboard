"""
Builds one Coach Board athlete with MPFB (MakeHuman for Blender) and exports it as a GLB for the web app.

Run headless, once per body:
  Blender -b --python make_athlete.py -- <female|male> <out.glb>

Needs Blender 4.2+ with the MPFB extension and these asset packs installed in MPFB's user data (all from
static.makehumancommunity.org/assets/assetpacks): makehuman_system_assets (CC0), shoes02 (CC-BY), skins01 (CC0). The
credits for the CC-BY shoes are in the app (Settings > About).

The body: a volleyball player, built from MakeHuman's macros and measured targets (see BODY): tall, long-limbed and
lean, with the shoulders, back and legs of a jumping, hitting athlete. The "game_engine" rig is fitted to that body
(detailed helpers). The kit is cut from the body's own skin, so it fits in every posture: a fitted short-sleeved jersey
whose hem lies over the shorts (no skin between them, whatever the arms do), shorts, knee pads and crew socks, plus
court shoes. The skin and the kit carry baked ambient occlusion (eye sockets, chin, fingers, the folds of the cloth),
so they read as skin and cloth, not plastic. The app recolours the jersey (team colour) and the shorts, and drives the
rig from its own 17-joint skeleton.
"""
import math
import os
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Vector, kdtree
from mathutils.bvhtree import BVHTree

from bl_ext.user_default.mpfb.services.humanservice import HumanService
from bl_ext.user_default.mpfb.services.locationservice import LocationService
from bl_ext.user_default.mpfb.services.targetservice import TargetService

args = sys.argv[sys.argv.index("--") + 1:]
gender, out = args[0], os.path.abspath(args[1])
female = gender == "female"
data = LocationService.get_user_data()


def asset(kind, name, ext="mhclo"):
    path = os.path.join(data, kind, name, name + "." + ext)
    if not os.path.isfile(path):
        # Some packs name the file differently from the folder: take the only file with that extension.
        folder = os.path.join(data, kind, name)
        found = [f for f in os.listdir(folder) if f.endswith("." + ext)]
        if len(found) != 1:
            raise IOError("no single ." + ext + " in " + folder)
        path = os.path.join(folder, found[0])
    return path


# ---------------------------------------------------------------------------------------------------------------------
# The body. Elite volleyball players are tall and long-limbed (women about 1.84 m, men about 1.98 m) and lean (body fat
# around 18 % and 11 %), with broad, muscular shoulders and upper back from hitting and blocking, strong quadriceps,
# glutes and calves from jumping, and a narrow waist. MakeHuman's macros give the build (muscle up, weight about
# average, a little taller for the longer legs); the targets shape what the macros leave generic. The app scales the
# model to each player's stature, so only the proportions matter here.
BODY = {
    True: {
        "macro": {"gender": 0.0, "age": 0.5, "muscle": 0.8, "weight": 0.55, "proportions": 1.0, "height": 0.8,
                  "cupsize": 0.4, "firmness": 0.8, "race": {"asian": 0.2, "caucasian": 0.6, "african": 0.2}},
        "targets": {
            # Shoulders and back: deltoids and a wider shoulder line (a hitter's), a slight V to the waist.
            "measure-shoulder-dist-incr": 0.3, "upperarm-shoulder-muscle-incr": 0.45, "torso-vshape-incr": 0.2,
            "torso-muscle-dorsi-incr": 0.2,
            # A flat, firm waist and belly.
            "measure-waist-circ-decr": 0.25, "stomach-pregnant-decr": 0.5,
            # Jumper's legs: quadriceps, calves and glutes.
            "upperleg-muscle-incr": 0.45, "lowerleg-muscle-incr": 0.4, "buttocks-volume-incr": 0.15,
            "upperarm-muscle-incr": 0.25, "lowerarm-muscle-incr": 0.25, "upperarm-fat-decr": 0.4,
            "measure-neck-circ-incr": 0.1, "breast-point-decr": 0.6, "nipple-point-decr": 1.0, "nipple-size-decr": 0.5,
        },
    },
    False: {
        "macro": {"gender": 1.0, "age": 0.5, "muscle": 0.8, "weight": 0.5, "proportions": 1.0, "height": 0.7,
                  "cupsize": 0.5, "firmness": 0.5, "race": {"asian": 0.2, "caucasian": 0.6, "african": 0.2}},
        "targets": {
            "measure-shoulder-dist-incr": 0.1, "upperarm-shoulder-muscle-incr": 0.2, "torso-vshape-incr": 0.2,
            "torso-muscle-dorsi-incr": 0.15, "torso-muscle-pectoral-incr": 0.1,
            "measure-waist-circ-decr": 0.25, "stomach-pregnant-decr": 0.6,
            "upperleg-muscle-incr": 0.45, "lowerleg-muscle-incr": 0.45,
            "upperarm-muscle-incr": 0.35, "lowerarm-muscle-incr": 0.35, "upperarm-fat-decr": 0.3,
            "measure-neck-circ-incr": 0.25,
        },
    },
}[female]

# The rest of the look: a ponytail (the volleyball classic) or short hair, natural brows, eyes, lashes, a young skin
# (the app varies its tone per player), and court shoes (low and light, laced; their outsole and logos made neutral).
LOOK = {
    True: {"hair": "ponytail01", "skin": "young_caucasian_female", "brows": "eyebrow001"},
    False: {"hair": "short02", "skin": "young_caucasian_male", "brows": "eyebrow002"},
}[female]

# Start from an empty scene (keeping the preferences, so MPFB stays enabled).
for obj in list(bpy.data.objects):
    bpy.data.objects.remove(obj, do_unlink=True)

# Not moved onto the floor yet: MPFB fits the rig to the body where MakeHuman made it (the origin at the hips), so the
# whole figure is lifted after rigging (moving the body first leaves the rig fitted 0.8 m too low). The detailed
# helpers carry the "joint-*" vertex groups the rig is fitted to: without them every body gets the rig of MakeHuman's
# default 1.7 m figure, with elbows, knees and neck where that figure has them (15 cm off on a 1.9 m man).
basemesh = HumanService.create_human(mask_helpers=True, detailed_helpers=True, extra_vertex_groups=True,
                                     feet_on_ground=False, scale=0.1, macro_detail_dict=BODY["macro"])
basemesh.name = "Body"
# The targets before the rig, so the rig is fitted to the shaped body (they move the joint helpers too). Arm and leg
# targets come in pairs (l-, r-).
for name, value in BODY["targets"].items():
    for side in (("l-", "r-") if name.startswith(("upperarm", "lowerarm", "upperleg", "lowerleg")) else ("",)):
        path = TargetService.target_full_path(side + name)
        if path is None:
            raise IOError("no target " + side + name)
        TargetService.load_target(basemesh, path, weight=value)
rig = HumanService.add_builtin_rig(basemesh, "game_engine")
rig.name = "Rig"

parts = [
    ("eyes", "low-poly", "Eyes"),
    ("eyebrows", LOOK["brows"], "Eyebrows"),
    ("eyelashes", "eyelashes01", "Eyelashes"),
    ("hair", LOOK["hair"], "Hair"),
    ("clothes", "punkduck_running_shoes_01", "Clothes"),
]
names = {"punkduck_running_shoes_01": "Shoes", LOOK["hair"]: "Hair", "low-poly": "Eyes", LOOK["brows"]: "Eyebrows",
         "eyelashes01": "Eyelashes"}
for kind, name, asset_type in parts:
    obj = HumanService.add_mhclo_asset(asset(kind, name), basemesh, asset_type=asset_type, subdiv_levels=0,
                                       material_type="MAKESKIN")
    obj.name = names[name]
    for slot in obj.material_slots:
        if slot.material:
            slot.material.name = names[name]

HumanService.set_character_skin(asset("skins", LOOK["skin"], "mhmat"), basemesh, skin_type="GAMEENGINE")
for slot in basemesh.material_slots:
    if slot.material:
        slot.material.name = "Skin"

# Bake every shape key (the body's shape) into the meshes.
for obj in [o for o in bpy.data.objects if o.type == "MESH"]:
    if obj.data.shape_keys:
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.shape_key_remove(all=True, apply_mix=True)

body = bpy.data.objects["Body"]
bones = rig.data.bones


def joint(name):
    """A bone's head in the bind pose (metres, Blender's frame: z up, the figure facing -y, its left at +x)."""
    return rig.matrix_world @ bones[name].head_local


skin_index = body.vertex_groups["body"].index
skin_z = [v.co.z for v in body.data.vertices if any(g.group == skin_index for g in v.groups)]
stature = max(skin_z) - min(skin_z)
floor = min(skin_z)
print("BODY", gender, "stature", round(stature, 3), "landmarks / stature:",
      {b: round((joint(b).z - floor) / stature, 3) for b in ("thigh_l", "calf_l", "foot_l", "pelvis", "spine_01",
                                                             "spine_02", "spine_03", "neck_01", "head", "upperarm_l",
                                                             "lowerarm_l", "hand_l")},
      "shoulder width", round(2 * joint("upperarm_l").x, 3))

# ---------------------------------------------------------------------------------------------------------------------
# The kit, cut from the skin. Each garment is a copy of the body's skin (its weights and all, so it moves exactly as
# the skin under it does), cut along smooth lines (scalar fields over the skin, see `cut`), lifted off the skin and
# given a hem. Where the skin turns inward (the small of the back, under the bust, the waist) the cloth spans across
# it instead of following it in (`drape`), as fabric does.

ARM = ("upperarm", "lowerarm", "hand", "thumb", "index", "middle", "ring", "pinky")


def dominant_bones(obj):
    """The bone moving each vertex most."""
    group_names = {g.index: g.name for g in obj.vertex_groups}
    out = []
    for v in obj.data.vertices:
        best, w = "", 0.0
        for g in v.groups:
            n = group_names[g.group]
            if n in bones and g.weight > w:
                best, w = n, g.weight
        out.append(best)
    return out


def side_of(bone):
    return 1 if bone.endswith("_l") else -1 if bone.endswith("_r") else 0


def cut(bm, field, bone_of, remove=True):
    """
    Cuts the mesh along the zero line of `field(vertex, bone)` and removes what lies on its positive side (`bone_of`:
    the bone moving each vertex most, extended to the vertices the cut makes). `remove=False` only draws the line in.
    """
    value = {v: field(v, bone_of.get(v, "")) for v in bm.verts}
    for v, s in value.items():
        if abs(s) < 1e-7:
            value[v] = -1e-7
    made = set()
    for e in [e for e in bm.edges if (value[e.verts[0]] > 0) != (value[e.verts[1]] > 0)]:
        a, b = e.verts
        t = value[a] / (value[a] - value[b])
        _, v = bmesh.utils.edge_split(e, a, t)
        value[v] = 0.0
        bone_of[v] = bone_of.get(a, "")
        made.add(v)
    for f in {f for v in made for f in v.link_faces}:
        on = [v for v in f.verts if v in made]
        if len(on) == 2:
            bmesh.ops.connect_verts(bm, verts=on)
    if remove:
        gone = [f for f in bm.faces if any(value[v] > 0 for v in f.verts)]
        bmesh.ops.delete(bm, geom=gone, context="FACES")


def without_details(verts, normal, sigma):
    """
    Takes the small forms out of a surface (bumps and dents narrower than about `sigma`, metres), keeping its larger
    shape: each vertex moves along its normal to the mean height of the surface around it (a Gaussian of width
    `sigma`, over the surface facing the same way), and back out by what that does on a three times larger scale (the
    roundness it would otherwise shave off).
    """
    P = np.array([v.co for v in verts], dtype=np.float64)
    N = np.array([normal[v] for v in verts], dtype=np.float64)
    d2 = ((P[:, None, :] - P[None, :, :]) ** 2).sum(-1)
    facing = np.clip(N @ N.T, 0.0, 1.0) ** 2
    height = np.einsum("ijk,ik->ij", P[None, :, :] - P[:, None, :], N)
    w = np.exp(-d2 / (2 * sigma ** 2)) * facing
    h = (w * height).sum(1) / w.sum(1)
    w = np.exp(-d2 / (2 * (3 * sigma) ** 2)) * facing
    h -= (w * h[None, :]).sum(1) / w.sum(1)
    for v, n, dh in zip(verts, N, h):
        v.co += Vector(n) * dh


def smooth_normals(verts, normal, sigma):
    """The normals averaged over the surface around each vertex (a Gaussian of width `sigma`, metres, over the surface
    facing the same way): light then runs smoothly over the cloth, whatever the skin's mesh does under it (MakeHuman
    packs rings of small faces around the nipples, the navel and the knees)."""
    P = np.array([v.co for v in verts], dtype=np.float64)
    N = np.array([normal[v] for v in verts], dtype=np.float64)
    d2 = ((P[:, None, :] - P[None, :, :]) ** 2).sum(-1)
    w = np.exp(-d2 / (2 * sigma ** 2)) * np.clip(N @ N.T, 0.0, 1.0) ** 2
    out = w @ N
    out /= np.linalg.norm(out, axis=1)[:, None]
    return {v: Vector(n) for v, n in zip(verts, out)}


def along_normals(verts, normal, steps):
    """Laplacian smoothing that moves each vertex only along its normal (`steps`: the factor of each pass), so the
    shape is smoothed while the mesh stays where it is on the surface (its weights, texture and lines with it)."""
    for step in steps:
        moved = [(sum((e.other_vert(v).co for e in v.link_edges), Vector()) / len(v.link_edges) - v.co).dot(normal[v])
                 * step for v in verts]
        for v, d in zip(verts, moved):
            v.co += normal[v] * d


def keep_largest(bm, count=1):
    """Keeps the `count` largest connected pieces (cut-off ears, hands and such go)."""
    seen, pieces = set(), []
    for f in bm.faces:
        if f in seen:
            continue
        piece, stack = [], [f]
        seen.add(f)
        while stack:
            g = stack.pop()
            piece.append(g)
            for e in g.edges:
                for h in e.link_faces:
                    if h not in seen:
                        seen.add(h)
                        stack.append(h)
        pieces.append(piece)
    pieces.sort(key=len, reverse=True)
    gone = [f for p in pieces[count:] for f in p]
    bmesh.ops.delete(bm, geom=gone, context="FACES")


def boundary_loops(bm):
    """The open edges of the mesh, as loops of vertices."""
    open_edges = {e for e in bm.edges if e.is_boundary}
    loops = []
    while open_edges:
        e = open_edges.pop()
        loop = [e.verts[0], e.verts[1]]
        while True:
            nxt = [x for x in loop[-1].link_edges if x in open_edges]
            if not nxt:
                break
            open_edges.discard(nxt[0])
            v = nxt[0].other_vert(loop[-1])
            if v is loop[0]:
                break
            loop.append(v)
        loops.append(loop)
    return loops


def garment(name, region, cuts, lift, pieces=1, smooth=12, details=0.0, drape_iterations=0, drape_below=math.inf,
            rim=0.002, bands=(), over=None):
    """
    A garment cut from the skin. `region(bone)` says which vertices may belong to it (by the bone moving them most);
    `cuts` are fields cutting away their positive side, in order; `lift(v, skin, normal)` is how far the cloth stands
    off the skin there (metres); it is draped below the height `drape_below`; `bands` are (field, width): a darker
    band (collar, cuffs) that wide inside that field's cut. Returns the object and the body's vertices it covers.
    """
    obj = body.copy()
    obj.data = body.data.copy()
    obj.name = name
    body.users_collection[0].objects.link(obj)
    for m in list(obj.modifiers):
        if m.type != "ARMATURE":
            obj.modifiers.remove(m)
    dominant = dominant_bones(body)
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.verts.ensure_lookup_table()
    deform = bm.verts.layers.deform.active
    skin_group = obj.vertex_groups["body"].index
    original = {v: v.index for v in bm.verts}
    bone_of = {v: dominant[v.index] for v in bm.verts}
    # Only the skin (not MakeHuman's helper geometry), only the region.
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if skin_group not in v[deform] or not region(bone_of[v])],
                     context="VERTS")
    on_skin = BVHTree.FromBMesh(bm)
    for field in cuts:
        cut(bm, field, bone_of)
    keep_largest(bm, pieces)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    covered = {original[v] for v in bm.verts if v in original}
    # A cut passing right by a vertex of the skin leaves slivers (edges of a millimetre or two) that fold over once the
    # line is evened out: collapsed first.
    bmesh.ops.dissolve_degenerate(bm, dist=0.002, edges=bm.edges[:])
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    # The cut lines run through the skin's faces wherever the field crosses their edges: evened out along themselves,
    # so collar, cuffs and hems are clean curves, not zigzags.
    # (Back on the skin after each pass: evening out a ring around a limb pulls it into the limb.)
    for loop in boundary_loops(bm):
        for _ in range(4):
            moved = [loop[k - 1].co.lerp(loop[(k + 1) % len(loop)].co, 0.5) for k in range(len(loop))]
            for v, co in zip(loop, moved):
                v.co = on_skin.find_nearest(v.co.lerp(co, 0.5))[0]
    # Bands: two lines drawn into the cloth along each band's edge (4 mm apart), so it is crisp, not as ragged as the
    # skin's faces; the shade per vertex.
    soft = 0.004
    for field, width in bands:
        for at in (width, width + soft):
            cut(bm, lambda v, b, f=field, at=at: f(v, b) + at, bone_of, remove=False)
    shade = {}
    for v in bm.verts:
        inside = max((f(v, bone_of.get(v, "")) + w for f, w in bands), default=-1.0)
        shade[v] = 0.6 + 0.4 * max(0.0, min(1.0, -inside / soft))
    bm.normal_update()
    normal = {v: v.normal.copy() for v in bm.verts}
    edge = {v for v in bm.verts if v.is_boundary}
    inner = [v for v in bm.verts if v not in edge]
    # Near the hems the skin stays under the cloth (see remove_skin): there the cloth keeps its lift off the real skin,
    # not just off the smoothed shape, or the skin shows through just inside the hem.
    real = {v: v.co.copy() for v in bm.verts}
    hems = kdtree.KDTree(len(edge))
    for k, v in enumerate(edge):
        hems.insert(v.co, k)
    hems.balance()
    near_hem = {v: max(0.0, min(1.0, (0.07 - hems.find(v.co)[2]) / 0.035)) if edge else 0.0 for v in bm.verts}
    # The cloth's own shape: the skin with its small forms (nipples, navel, ribs, the kneecap's edges) smoothed away by
    # Taubin's filter (smoothing without shrinking), so it shows the body's shape but not its details.
    if details:
        without_details(inner, normal, details)
    along_normals(inner, normal, [0.5, -0.53] * smooth)
    # Lift the cloth off that shape.
    skin = {v: v.co.copy() for v in bm.verts}
    least = {v: lift(v, skin[v], normal[v]) for v in bm.verts}

    def clear(verts):
        for v in verts:
            off = (v.co - skin[v]).dot(normal[v])
            if off < least[v]:
                v.co += normal[v] * (least[v] - off)
            off = (v.co - real[v]).dot(normal[v])
            if off < least[v] * near_hem[v]:
                v.co += normal[v] * (least[v] * near_hem[v] - off)

    for v in bm.verts:
        v.co = skin[v] + normal[v] * least[v]
    clear(bm.verts)
    # Drape: smooth the cloth, never closer to the skin than its lift, so it spans hollows instead of dipping in.
    # Not on the upper arms (they move against the trunk: a web of cloth from the armpit would cut into them).
    free = [v for v in inner if not bone_of.get(v, "").startswith("upperarm") and skin[v].z < drape_below]
    for _ in range(drape_iterations):
        along_normals(free, normal, [0.5])
        clear(free)
    # Over another garment (the jersey over the shorts' waistband): never in it, 4 mm out from it; the cloth around
    # what that lifts smoothed with it, so it lies over the waistband instead of being pinched out at a few points.
    if over is not None:
        def lie_over(verts):
            lifted = []
            for v in verts:
                hit = over.ray_cast(v.co - normal[v] * 0.03, normal[v], 0.06)[0]
                if hit is not None and (v.co - hit).dot(normal[v]) < 0.004:
                    v.co = hit + normal[v] * 0.004
                    lifted.append(v)
            return lifted

        lifted = lie_over(bm.verts)
        if lifted:
            near = kdtree.KDTree(len(lifted))
            for k, v in enumerate(lifted):
                near.insert(v.co, k)
            near.balance()
            around = [v for v in inner if near.find(v.co)[2] < 0.06]
            for _ in range(8):
                along_normals(around, normal, [0.5])
                clear(around)
                lie_over(around)
    bm.normal_update()
    shading = smooth_normals(list(bm.verts), {v: v.normal for v in bm.verts}, 0.012 * H)
    # The hem: the open edges turned in toward the skin by the cloth's thickness.
    ret = bmesh.ops.extrude_edge_only(bm, edges=[e for e in bm.edges if e.is_boundary])
    for v in [x for x in ret["geom"] if isinstance(x, bmesh.types.BMVert)]:
        src = min(v.link_edges, key=lambda e: e.calc_length()).other_vert(v)
        v.co = src.co - normal[src] * min(rim, 0.4 * least[src])
        least[v] = least[src]
        shade[v] = shade[src]
    bm.normal_update()
    # The bands' shade as a vertex colour the bake multiplies in. (A new layer invalidates references to the mesh's
    # elements: shades and normals are listed in order first.)
    shades = [shade[v] for v in bm.verts]
    normals = [shading.get(v, v.normal) for v in bm.verts]
    if bands:
        layer = bm.verts.layers.float_color.new("trim")
        for v, k in zip(bm.verts, shades):
            v[layer] = (k, k, k, 1.0)
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.normals_split_custom_set_from_vertices(normals)
    obj.data.materials.clear()
    print("GARMENT", name, len(obj.data.vertices), "verts", len(obj.data.polygons), "faces", len(covered),
          "skin verts under it")
    return obj, covered


# Landmarks (bind pose).
hip_l, hip_r = joint("thigh_l"), joint("thigh_r")
knee_l, knee_r = joint("calf_l"), joint("calf_r")
ankle_l, ankle_r = joint("foot_l"), joint("foot_r")
shoulder_l, shoulder_r = joint("upperarm_l"), joint("upperarm_r")
elbow_l, elbow_r = joint("lowerarm_l"), joint("lowerarm_r")
neck = joint("neck_01")
waist_z = joint("spine_01").z
H = stature / 1.8  # lengths below are for a 1.8 m figure

# Jersey: from a crew neck to a hem a hand's width below the shorts' waistband, short sleeves cut square to the arm.
hem_z = max(waist_z - 0.095 * H, hip_l.z + 0.03 * H)
sleeve = 0.47 if female else 0.55  # of the upper arm, from the shoulder joint


def sleeve_cut(side):
    s, e = (shoulder_l, elbow_l) if side > 0 else (shoulder_r, elbow_r)
    axis = (e - s).normalized()
    length = sleeve * (e - s).length
    return lambda v, bone: ((v.co - s).dot(axis) - length) if bone.startswith(ARM) and side_of(bone) == side else -1.0


def neck_cut(v, bone):
    # Above a plane through the base of the neck, tilted down to the front (the collar sits at the notch of the
    # breastbone in front, at the prominent vertebra behind), and within an oval around the neck.
    centre = Vector((0.0, neck.y, neck.z - (0.03 if female else 0.035) * H))
    tilt = math.radians(24)
    up = Vector((0.0, -math.sin(tilt), math.cos(tilt)))  # -y is the front: the plane drops toward it
    above = (v.co - centre).dot(up)
    rx, ry = 0.075 * H, 0.068 * H
    inside = rx - math.hypot(v.co.x, (v.co.y - neck.y) * rx / ry)
    return min(above, inside)


def jersey_lift(v, skin, n):
    # Close over chest, back and shoulders; standing off a little more toward the hem, where it lies over the shorts'
    # waistband and falls straight from the chest.
    lower = max(0.0, min(1.0, (waist_z + 0.04 * H - skin.z) / (0.14 * H)))
    return 0.0055 + 0.0075 * lower


# Shorts: waistband at the navel; women's fitted and short (hem 13 cm below the hip joint), men's to a hand above the
# knee and looser toward the hem on the outside (not between the thighs, where the legs meet).
leg_len = (knee_l - hip_l).length
hem_down = (0.30 if female else 0.58) * leg_len


def leg_cut(side):
    h, k = (hip_l, knee_l) if side > 0 else (hip_r, knee_r)
    axis = (k - h).normalized()
    return lambda v, bone: ((v.co - h).dot(axis) - hem_down) if v.co.x * side > 0.0 else -1.0


def shorts_lift(v, skin, n):
    if female:
        return 0.005
    down = max(0.0, min(1.0, (hip_l.z - skin.z) / hem_down))
    outward = max(0.0, n.x * (1 if skin.x > 0 else -1) + 0.25 * -n.y)
    return 0.005 + 0.012 * down * down * min(1.0, outward)


shorts, under_shorts = garment(
    "Shorts", lambda b: not b.startswith(ARM + ("head", "neck", "clavicle")),
    [lambda v, b: v.co.z - waist_z, leg_cut(1), leg_cut(-1)], shorts_lift, smooth=12, details=0.012 * H,
    drape_iterations=6 if female else 10,
    drape_below=hip_l.z)  # not under the jersey's hem, which must stay outside it


def surface(obj):
    """A garment's surface, for finding it along rays."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    tree = BVHTree.FromBMesh(bm)
    bm.free()
    return tree


shirt, under_shirt = garment(
    "Shirt", lambda b: not b.startswith(("head", "neck")) or b == "neck_01",
    [sleeve_cut(1), sleeve_cut(-1), lambda v, b: hem_z - v.co.z, neck_cut],
    jersey_lift, smooth=12, details=0.025 * H, drape_iterations=30, over=surface(shorts),
    bands=[(sleeve_cut(1), 0.016 * H), (sleeve_cut(-1), 0.016 * H), (neck_cut, 0.014 * H)])

# Knee pads: a sleeve from a hand above the knee joint to a hand below it, thicker over the kneecap.
def pad_cut(side, top, low):
    h, k, a = (hip_l, knee_l, ankle_l) if side > 0 else (hip_r, knee_r, ankle_r)
    axis = ((k - h).normalized() + (a - k).normalized()).normalized()
    def field(v, bone):
        if side_of(bone) != side:
            return 1.0
        t = (v.co - k).dot(axis)
        return max(-top - t, t - low)
    return field


def pad_lift(v, skin, n):
    k = knee_l if skin.x > 0 else knee_r
    front = max(0.0, -n.y - 0.25) / 0.75
    centre = math.exp(-((skin.z - (k.z + 0.012 * H)) / (0.045 * H)) ** 2)
    return 0.005 + 0.008 * centre * front ** 1.5


pad_l, under_pad_l = garment("PadL", lambda b: b.startswith(("thigh", "calf")) and side_of(b) > 0,
                             [pad_cut(1, 0.07 * H, 0.065 * H)], pad_lift, drape_iterations=4)
pad_r, under_pad_r = garment("PadR", lambda b: b.startswith(("thigh", "calf")) and side_of(b) < 0,
                             [pad_cut(-1, 0.07 * H, 0.065 * H)], pad_lift, drape_iterations=4)


# Crew socks: from inside the shoe to a hand above the ankle bone.
def sock_cut(side):
    a = ankle_l if side > 0 else ankle_r
    return lambda v, bone: max(v.co.z - (a.z + 0.115 * H), (a.z - 0.03 * H) - v.co.z) if side_of(bone) == side else 1.0


sock_l, under_sock_l = garment("SockL", lambda b: b.startswith(("calf", "foot", "ball")) and side_of(b) > 0,
                               [sock_cut(1)], lambda v, s, n: 0.0025, smooth=6, drape_iterations=3, rim=0.0015)
sock_r, under_sock_r = garment("SockR", lambda b: b.startswith(("calf", "foot", "ball")) and side_of(b) < 0,
                               [sock_cut(-1)], lambda v, s, n: 0.0025, smooth=6, drape_iterations=3, rim=0.0015)

# The pads and socks as one mesh ("Gear": one draw), its colours in its texture.
for obj, colour in ((pad_l, (0.02, 0.02, 0.025)), (pad_r, (0.02, 0.02, 0.025)), (sock_l, (0.86, 0.86, 0.85)),
                    (sock_r, (0.86, 0.86, 0.85))):
    attr = obj.data.color_attributes.new("tint", "FLOAT_COLOR", "POINT")
    for d in attr.data:
        d.color = (*colour, 1.0)
bpy.ops.object.select_all(action="DESELECT")
for obj in (pad_l, pad_r, sock_l, sock_r):
    obj.select_set(True)
bpy.context.view_layer.objects.active = pad_l
bpy.ops.object.join()
gear = pad_l
gear.name = "Gear"

# ---------------------------------------------------------------------------------------------------------------------
# The skin under the kit goes, so it cannot poke through when the body bends (shoulders under a raised arm, hips in a
# deep squat, the knee bent in a dig); two rings of skin stay along every edge of what goes, so no gap opens at a hem.


def remove_skin(covered):
    bm = bmesh.new()
    bm.from_mesh(body.data)
    bm.verts.ensure_lookup_table()
    covered = set(covered)
    for _ in range(2):
        edge = {i for i in covered
                if any(e.other_vert(bm.verts[i]).index not in covered for e in bm.verts[i].link_edges)}
        covered -= edge
    faces = [f for f in bm.faces if all(v.index in covered for v in f.verts)]
    bmesh.ops.delete(bm, geom=faces, context="FACES_ONLY")
    bm.to_mesh(body.data)
    bm.free()
    print("SKIN REMOVED", len(faces), "faces")


remove_skin(under_shirt | under_shorts | under_pad_l | under_pad_r | under_sock_l | under_sock_r)

# ---------------------------------------------------------------------------------------------------------------------
# Textures: the shoes' white court design with its blue outsole and logos made neutral; the skin and the kit with baked
# ambient occlusion (soft darkening where surfaces meet: eye sockets, under the chin, between the fingers, the creases
# of the cloth), which the app's real-time light cannot give.
shoes = bpy.data.objects["Shoes"]
source = bpy.data.images.load(os.path.join(data, "clothes", "punkduck_tennis_shoes", "tennisshoes.png"))
source.scale(512, 512)
px = np.array(source.pixels[:], dtype=np.float32).reshape(-1, 4)
rgb = px[:, :3]
lum = rgb @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
blue = (rgb[:, 2] - np.maximum(rgb[:, 0], rgb[:, 1])) > 0.035
# Blue accents to a dark graphite, keeping their shading.
rgb[blue] = (np.clip(lum[blue] * 0.55, 0.0, 1.0)[:, None] * np.array([1.0, 1.0, 1.04], dtype=np.float32))
px[:, :3] = rgb
# A new image (the exporter would take a loaded one from its file, unchanged).
court = bpy.data.images.new("Shoes", 512, 512, alpha=True)
court.pixels = px.ravel()
bpy.data.images.remove(source)
for slot in shoes.material_slots:
    for node in slot.material.node_tree.nodes:
        if node.type == "TEX_IMAGE" and node.image and "normal" not in node.image.name.lower():
            node.image = court

# The eyes' iris from MakeHuman's reddish brown to a plain dark brown (less red, as a new image for the same reason).
eyes = bpy.data.objects["Eyes"]
for slot in eyes.material_slots:
    for node in slot.material.node_tree.nodes:
        if node.type == "TEX_IMAGE" and node.image and "normal" not in node.image.name.lower():
            src = node.image
            src.scale(256, 256)
            px = np.array(src.pixels[:], dtype=np.float32).reshape(-1, 4)
            r, g, b = px[:, 0], px[:, 1], px[:, 2]
            red = r > g * 1.15
            px[red, 0] = g[red] + (r[red] - g[red]) * 0.45
            px[red, 2] = b[red] * 0.85
            iris = bpy.data.images.new("Eyes", 256, 256, alpha=True)
            iris.pixels = px.ravel()
            node.image = iris

scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.use_denoising = False


def bake(obj, size, distance, strength, samples, base=None, use_trim=False, use_tint=False, name=None):
    """Bakes the object's ambient occlusion (times its texture `base`, its trim and tint colours) into a new texture."""
    scene.cycles.samples = samples
    img = bpy.data.images.new(name or obj.name, size, size, alpha=False)
    mat = bpy.data.materials.new("bake")
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    ao = nt.nodes.new("ShaderNodeAmbientOcclusion")
    ao.samples = 16
    ao.inputs["Distance"].default_value = distance
    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    mix.inputs["Factor"].default_value = strength
    mix.inputs[6].default_value = (1, 1, 1, 1)
    nt.links.new(ao.outputs["Color"], mix.inputs[7])
    colour = mix.outputs[2]
    for layer, wanted in (("trim", use_trim), ("tint", use_tint)):
        if not wanted:
            continue
        attr = nt.nodes.new("ShaderNodeAttribute")
        attr.attribute_name = layer
        m = nt.nodes.new("ShaderNodeMix")
        m.data_type = "RGBA"
        m.blend_type = "MULTIPLY"
        m.inputs["Factor"].default_value = 1.0
        nt.links.new(colour, m.inputs[6])
        nt.links.new(attr.outputs["Color"], m.inputs[7])
        colour = m.outputs[2]
    if base is not None:
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = base
        m = nt.nodes.new("ShaderNodeMix")
        m.data_type = "RGBA"
        m.blend_type = "MULTIPLY"
        m.inputs["Factor"].default_value = 1.0
        nt.links.new(colour, m.inputs[6])
        nt.links.new(tex.outputs["Color"], m.inputs[7])
        colour = m.outputs[2]
    emit = nt.nodes.new("ShaderNodeEmission")
    nt.links.new(colour, emit.inputs["Color"])
    out_node = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(emit.outputs["Emission"], out_node.inputs["Surface"])
    target = nt.nodes.new("ShaderNodeTexImage")
    target.image = img
    nt.nodes.active = target
    saved = [s.material for s in obj.material_slots]
    if not saved:
        obj.data.materials.append(mat)
    for s in obj.material_slots:
        s.material = mat
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.bake(type="EMIT", margin=6, use_clear=True)
    if saved:
        for s, m in zip(obj.material_slots, saved):
            s.material = m
    else:
        obj.data.materials.clear()
    bpy.data.materials.remove(mat)
    return img


def unwrap(obj):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.02)
    bpy.ops.object.mode_set(mode="OBJECT")


def cloth_material(name, image, roughness):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    tex = mat.node_tree.nodes.new("ShaderNodeTexImage")
    tex.image = image
    mat.node_tree.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = roughness
    return mat


# Hair, brows and lashes are cards with see-through parts: left out of the occlusion (they would smudge the skin).
for o in bpy.data.objects:
    if o.name in ("Hair", "Eyebrows", "Eyelashes"):
        o.hide_render = True

skin_image = next(n.image for n in body.material_slots[0].material.node_tree.nodes if n.type == "TEX_IMAGE" and n.image
                  and "normal" not in n.image.name.lower())
if skin_image.size[0] > 1024:
    skin_image.scale(1024, 1024)
# The skin's own occlusion only: the kit's would end in a ragged line on the skin just under each hem (the skin's faces
# are coarser than the cloth's edge).
for o in (shirt, shorts, gear, shoes):
    o.hide_render = True
baked_skin = bake(body, 1024, 0.035 * H, 0.75, 96, base=skin_image, name="Skin")
for o in (shirt, shorts, gear, shoes):
    o.hide_render = False
for n in body.material_slots[0].material.node_tree.nodes:
    if n.type == "TEX_IMAGE" and n.image == skin_image:
        n.image = baked_skin

# Each garment shaded by the body and itself (not by the layer under it: the shorts' waistband would show through the
# jersey as a smudge).
for obj, size, roughness, trim, tint in ((shirt, 512, 0.85, True, False), (shorts, 512, 0.8, False, False),
                                         (gear, 256, 0.75, False, True)):
    for other in (shirt, shorts, gear):
        other.hide_render = other is not obj
    unwrap(obj)
    img = bake(obj, size, 0.045 * H, 0.85, 64, use_trim=trim, use_tint=tint, name=obj.name)
    obj.data.materials.append(cloth_material(obj.name, img, roughness))
for o in bpy.data.objects:
    o.hide_render = False
    if o.type == "MESH":
        o.data.name = o.name
        for a in [a.name for a in o.data.color_attributes]:
            o.data.color_attributes.remove(o.data.color_attributes[a])

# Lighter meshes: no hair or shoe needs more than about 6000 triangles on an iPad.
for obj in [o for o in bpy.data.objects if o.type == "MESH" and o.name in ("Shoes", "Hair")]:
    tris = sum(len(p.vertices) - 2 for p in obj.data.polygons)
    if tris > 6000:
        mod = obj.modifiers.new("Lighter", "DECIMATE")
        mod.ratio = 6000 / tris
        # Before the armature, so the export applies it to the rest shape.
        while obj.modifiers.find("Lighter") > 0:
            bpy.ops.object.select_all(action="DESELECT")
            obj.select_set(True)
            bpy.context.view_layer.objects.active = obj
            bpy.ops.object.modifier_move_up(modifier="Lighter")

# Web-sized textures: as large as they show, no larger (the face and hair up close, the eyes and shoes small).
limits = {"Hair": 1024 if female else 512, "Eyes": 256, "Eyebrows": 256, "Eyelashes": 256, "Shoes": 512}
for obj in [o for o in bpy.data.objects if o.type == "MESH"]:
    for slot in obj.material_slots:
        if not slot.material or not slot.material.use_nodes:
            continue
        for node in slot.material.node_tree.nodes:
            img = node.image if node.type == "TEX_IMAGE" else None
            if img is None or not img.size[0]:
                continue
            most = limits.get(obj.name, 1024)
            if max(img.size) > most:
                f = most / max(img.size)
                img.scale(max(1, int(img.size[0] * f)), max(1, int(img.size[1] * f)))

# Stand the figure on the floor: the lowest point of the body or the shoes at z = 0.
lowest = min((obj.matrix_world @ v.co).z for obj in bpy.data.objects if obj.type == "MESH" and obj.name in ("Body", "Shoes")
             for v in obj.data.vertices)
rig.location.z -= lowest
bpy.context.view_layer.update()
print("LIFTED", round(-lowest, 3), "pelvis at", round((rig.matrix_world @ rig.data.bones["pelvis"].head_local).z, 3),
      "elbow at", [round(c, 3) for c in rig.matrix_world @ rig.data.bones["lowerarm_l"].head_local],
      "head at", round((rig.matrix_world @ rig.data.bones["head"].head_local).z, 3))

# Report what goes out.
for obj in bpy.data.objects:
    if obj.type == "MESH":
        mods = ", ".join(m.type for m in obj.modifiers)
        print("MESH", obj.name, len(obj.data.vertices), "verts", len(obj.data.polygons), "faces", "mods:", mods,
              "mats:", [s.material.name for s in obj.material_slots if s.material])
print("BONES", len(rig.data.bones), [b.name for b in rig.data.bones])

bpy.ops.object.select_all(action="SELECT")
bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", use_selection=False, export_apply=True,
                          export_skins=True, export_morph=False, export_animations=False, export_yup=True,
                          export_image_format="WEBP", export_texcoords=True, export_normals=True,
                          export_materials="EXPORT", export_attributes=False)
print("EXPORTED", out, os.path.getsize(out))
