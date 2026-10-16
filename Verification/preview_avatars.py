"""Offline avatar preview: renders skinned meshes exported by AvatarExportTests into a contact sheet.

Usage: python3 preview_avatars.py <export dir> <out.png> [columns] [yaw degrees]
A tiny numpy z-buffer rasterizer with Lambert shading and the app's material colours, three-quarter view.
"""
import json, math, os, sys
import numpy as np
from PIL import Image, ImageDraw

MATERIALS = {0: (0.42, 0.47, 0.60), 1: (1.0, 0.0, 0.5), 2: (0.067, 0.094, 0.227), 3: (0.118, 0.153, 0.322),
             4: (0.91, 0.925, 0.96), 5: (0.043, 0.063, 0.141), 6: (0.85, 0.87, 0.92)}

def render(mesh, size=(260, 340), yaw=-35.0, pitch=12.0):
    v = np.array(mesh["vertices"]).reshape(-1, 3)
    n = np.array(mesh["normals"]).reshape(-1, 3)
    mats = np.array(mesh["materials"])
    tri = np.array(mesh["indices"]).reshape(-1, 3)
    y, p = math.radians(yaw), math.radians(pitch)
    ry = np.array([[math.cos(y), 0, math.sin(y)], [0, 1, 0], [-math.sin(y), 0, math.cos(y)]])
    rx = np.array([[1, 0, 0], [0, math.cos(p), -math.sin(p)], [0, math.sin(p), math.cos(p)]])
    rot = rx @ ry
    cv = v @ rot.T          # camera looks along -Z toward the body's front (+Z faces the viewer)
    cn = n @ rot.T
    w, h = size
    scale = h / 2.75
    sx = w / 2 + cv[:, 0] * -scale
    sy = h - 12 - cv[:, 1] * scale
    depth = cv[:, 2]
    light = np.array([0.35, 0.8, 0.5]); light /= np.linalg.norm(light)
    img = np.zeros((h, w, 3)) + np.array([0.02, 0.031, 0.078])
    zbuf = np.full((h, w), -1e9)
    # Floor line.
    floor_y = int(h - 12)
    img[floor_y:floor_y + 1, :, :] = (1.0, 0.0, 0.5)
    for t in tri:
        x0, x1, x2 = sx[t]; y0, y1, y2 = sy[t]
        minx, maxx = int(max(0, math.floor(min(x0, x1, x2)))), int(min(w - 1, math.ceil(max(x0, x1, x2))))
        miny, maxy = int(max(0, math.floor(min(y0, y1, y2)))), int(min(h - 1, math.ceil(max(y0, y1, y2))))
        if minx > maxx or miny > maxy:
            continue
        area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
        if abs(area) < 1e-9:
            continue
        xs, ys = np.meshgrid(np.arange(minx, maxx + 1) + 0.5, np.arange(miny, maxy + 1) + 0.5)
        w0 = ((x1 - xs) * (y2 - ys) - (x2 - xs) * (y1 - ys)) / area
        w1 = ((x2 - xs) * (y0 - ys) - (x0 - xs) * (y2 - ys)) / area
        w2 = 1 - w0 - w1
        inside = (w0 >= 0) & (w1 >= 0) & (w2 >= 0)
        if not inside.any():
            continue
        d = w0 * depth[t[0]] + w1 * depth[t[1]] + w2 * depth[t[2]]
        nn = cn[t].mean(axis=0); nn /= (np.linalg.norm(nn) + 1e-12)
        if nn[2] < 0:
            nn = nn  # back faces still shade (mesh is closed); keep normal
        base = np.array(MATERIALS.get(int(mats[t[0]]), (0.5, 0.5, 0.5)))
        lam = max(0.0, float(nn @ light))
        rim = (1 - abs(nn[2])) ** 3
        col = base * (0.35 + 0.75 * lam) + np.array([1.0, 0.0, 0.5]) * rim * 0.35
        sub = zbuf[miny:maxy + 1, minx:maxx + 1]
        upd = inside & (d > sub)
        sub[upd] = d[upd]
        img[miny:maxy + 1, minx:maxx + 1][upd] = np.clip(col, 0, 1)
    return Image.fromarray((img * 255).astype(np.uint8))

def main():
    src, out = sys.argv[1], sys.argv[2]
    cols = int(sys.argv[3]) if len(sys.argv) > 3 else 6
    yaw = float(sys.argv[4]) if len(sys.argv) > 4 else -35.0
    files = sorted(f for f in os.listdir(src) if f.endswith(".json"))
    tiles = []
    for f in files:
        mesh = json.load(open(os.path.join(src, f)))
        im = render(mesh, yaw=yaw)
        ImageDraw.Draw(im).text((6, 4), f"{mesh['role']} {mesh['posture']}", fill=(255, 255, 255))
        tiles.append(im)
    rows = (len(tiles) + cols - 1) // cols
    tw, th = tiles[0].size
    sheet = Image.new("RGB", (cols * tw, rows * th), (5, 8, 20))
    for i, im in enumerate(tiles):
        sheet.paste(im, ((i % cols) * tw, (i // cols) * th))
    sheet.save(out)
    print(out, len(tiles))

if __name__ == "__main__":
    main()
