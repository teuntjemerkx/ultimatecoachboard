"""
Builds one Coach Board athlete with MPFB (MakeHuman for Blender) and exports it as a GLB for the web app.

Run headless, once per body:
  Blender -b --python make_athlete.py -- <female|male> <out.glb>

Needs Blender 4.2+ with the MPFB extension and these asset packs installed in MPFB's user data (all from
static.makehumancommunity.org/assets/assetpacks): makehuman_system_assets (CC0), shirts01 (CC0), pants03 (CC-BY),
shoes02 (CC-BY), skins01 and skins02 (CC0). The credits for the CC-BY assets are in the app (Settings > About).

The body: an athletic young adult (muscle 0.8, weight 0.45, ideal proportions) with the "game_engine" rig, the base
mesh's skin texture, eyes, eyebrows, eyelashes and hair, a shirt, shorts and shoes. Shape keys are baked, hidden body
parts under clothes are removed, textures are scaled to at most 1024 pixels. The app recolours the shirt (team colour),
the shorts and the shoes, and drives the rig from its own 17-joint skeleton.
"""
import os
import sys

import bpy

from bl_ext.user_default.mpfb.services.humanservice import HumanService
from bl_ext.user_default.mpfb.services.locationservice import LocationService

args = sys.argv[sys.argv.index("--") + 1:]
gender, out = args[0], os.path.abspath(args[1])
female = gender == "female"
data = LocationService.get_user_data()


def asset(kind, name, ext="mhclo"):
    path = os.path.join(data, kind, name, name + "." + ext) if ext != "mhclo" or kind != "eyes" else os.path.join(data, kind, name, name + ".mhclo")
    if not os.path.isfile(path):
        # Some packs name the file differently from the folder: take the only file with that extension.
        folder = os.path.join(data, kind, name)
        found = [f for f in os.listdir(folder) if f.endswith("." + ext)]
        if len(found) != 1:
            raise IOError("no single ." + ext + " in " + folder)
        path = os.path.join(folder, found[0])
    return path


# A tucked t-shirt with collar and cuffs (the app gives it the team colour), plain shorts, white court shoes with high
# socks. (The "crude" t-shirts have ragged, half-transparent hems that tear open when an arm goes up.)
OUTFIT = {
    True: {"hair": "ponytail01", "shirt": "toigo_basic_tucked_t-shirt", "shorts": "mindfront_male_swimming_trunks_02",
           "shoes": "punkduck_tennis_shoes", "skin": "young_caucasian_female", "brows": "eyebrow001"},
    False: {"hair": "short02", "shirt": "toigo_basic_tucked_t-shirt", "shorts": "mindfront_male_swimming_trunks_01",
            "shoes": "punkduck_tennis_shoes", "skin": "young_caucasian_male", "brows": "eyebrow002"},
}[female]

# Start from an empty scene (keeping the preferences, so MPFB stays enabled).
for obj in list(bpy.data.objects):
    bpy.data.objects.remove(obj, do_unlink=True)

macro = {
    "gender": 0.0 if female else 1.0,
    "age": 0.5,
    "muscle": 0.8,
    "weight": 0.45,
    "proportions": 1.0,
    "height": 0.6,
    "cupsize": 0.45,
    "firmness": 0.75,
    "race": {"asian": 0.2, "caucasian": 0.6, "african": 0.2},
}
# Not moved onto the floor yet: MPFB fits the rig to the body where MakeHuman made it (the origin at the hips), so the
# whole figure is lifted after rigging (moving the body first leaves the rig fitted 0.8 m too low). The detailed
# helpers carry the "joint-*" vertex groups the rig is fitted to: without them every body gets the rig of MakeHuman's
# default 1.7 m figure, with elbows, knees and neck where that figure has them (15 cm off on a 1.9 m man).
basemesh = HumanService.create_human(mask_helpers=True, detailed_helpers=True, extra_vertex_groups=True,
                                     feet_on_ground=False, scale=0.1, macro_detail_dict=macro)
basemesh.name = "Body"
rig = HumanService.add_builtin_rig(basemesh, "game_engine")
rig.name = "Rig"

parts = [
    ("eyes", "low-poly", "Eyes"),
    ("eyebrows", OUTFIT["brows"], "Eyebrows"),
    ("eyelashes", "eyelashes01", "Eyelashes"),
    ("hair", OUTFIT["hair"], "Hair"),
    ("clothes", OUTFIT["shirt"], "Clothes"),
    ("clothes", OUTFIT["shorts"], "Clothes"),
    ("clothes", OUTFIT["shoes"], "Clothes"),
]
names = {OUTFIT["shirt"]: "Shirt", OUTFIT["shorts"]: "Shorts", OUTFIT["shoes"]: "Shoes", OUTFIT["hair"]: "Hair",
         "low-poly": "Eyes", OUTFIT["brows"]: "Eyebrows", "eyelashes01": "Eyelashes"}
for kind, name, asset_type in parts:
    obj = HumanService.add_mhclo_asset(asset(kind, name), basemesh, asset_type=asset_type, subdiv_levels=0,
                                       material_type="MAKESKIN")
    obj.name = names[name]
    for slot in obj.material_slots:
        if slot.material:
            slot.material.name = names[name]

HumanService.set_character_skin(asset("skins", OUTFIT["skin"], "mhmat"), basemesh, skin_type="GAMEENGINE")
for slot in basemesh.material_slots:
    if slot.material:
        slot.material.name = "Skin"

# Bake every shape key (the body's macro shape) into the meshes.
for obj in [o for o in bpy.data.objects if o.type == "MESH"]:
    if obj.data.shape_keys:
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.shape_key_remove(all=True, apply_mix=True)

# The skin under the shirt and the shorts is removed, so it cannot poke through when the body bends (shoulders under a
# raised arm, hips in a deep squat). A vertex goes when a ray along its normal meets the garment within 6 cm; two rings
# of skin are kept along every edge of what goes, so no gap opens at a hem.
import bmesh
from mathutils.bvhtree import BVHTree


def remove_skin_under(body, garments):
    depsgraph = bpy.context.evaluated_depsgraph_get()
    trees = []
    for g in garments:
        bm = bmesh.new()
        bm.from_object(g, depsgraph)
        bm.transform(g.matrix_world)
        trees.append(BVHTree.FromBMesh(bm))
        bm.free()
    bm = bmesh.new()
    bm.from_mesh(body.data)
    bm.verts.ensure_lookup_table()
    world = body.matrix_world
    normal_world = world.to_3x3().inverted().transposed()
    covered = set()
    for v in bm.verts:
        o = world @ v.co
        n = (normal_world @ v.normal).normalized()
        for t in trees:
            hit = t.ray_cast(o - n * 0.002, n, 0.06)
            if hit[0] is not None:
                covered.add(v.index)
                break
    for _ in range(2):
        edge = {v.index for v in bm.verts if v.index in covered and any(e.other_vert(v).index not in covered for e in v.link_edges)}
        covered -= edge
    faces = [f for f in bm.faces if all(v.index in covered for v in f.verts)]
    bmesh.ops.delete(bm, geom=faces, context="FACES_ONLY")
    bm.to_mesh(body.data)
    bm.free()
    print("SKIN REMOVED", len(faces), "faces under", [g.name for g in garments])


remove_skin_under(bpy.data.objects["Body"], [bpy.data.objects["Shirt"], bpy.data.objects["Shorts"]])

# Lighter clothes: no garment needs more than about 6000 triangles on an iPad.
for obj in [o for o in bpy.data.objects if o.type == "MESH" and o.name in ("Shirt", "Shorts", "Shoes", "Hair")]:
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

# Web-sized textures.
for img in bpy.data.images:
    if img.size[0] > 1024 or img.size[1] > 1024:
        f = 1024 / max(img.size[0], img.size[1])
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
                          export_materials="EXPORT")
print("EXPORTED", out, os.path.getsize(out))
