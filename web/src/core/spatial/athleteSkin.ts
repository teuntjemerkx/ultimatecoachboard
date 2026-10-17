// Web addition: an athlete's mesh skinned on the CPU exactly as three.js draws it (linear blend skinning, the mesh
// bound where it stood in the file), for measuring the body offline and in tests.
import type { GlbSkinned, GlbSkinnedMesh } from "./glb";
import { Rigid, V3 } from "./math3d";

/** Column-major 4x4 product a * b. */
function mul4(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  const o = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}

/** A rigid transform with a uniform scale as a column-major 4x4 matrix. */
function matrix(t: Rigid, scale: number): number[] {
  const q = t.rotation;
  const x = q.x, y = q.y, z = q.z, w = q.w;
  const m = [
    1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
    t.translation.x, t.translation.y, t.translation.z, 1,
  ];
  for (let i = 0; i < 12; i++) if (i % 4 !== 3) m[i] *= scale;
  return m;
}

/**
 * World positions of a mesh's vertices with its bones at `boneWorld` (one per bone, in `boneNodes` order, the root's
 * scale applied to all of them): sum of weight * boneWorld * inverseBind * meshBind * vertex.
 */
export function skinnedPositions(glb: GlbSkinned, mesh: GlbSkinnedMesh, boneNodes: readonly number[], boneWorld: readonly Rigid[],
  scale: number, meshBind: Rigid): V3[] {
  const boneOfNode = new Map(boneNodes.map((node, i) => [node, i]));
  const joint = glb.skinJoints.map((node, k) => {
    const b = boneOfNode.get(node);
    if (b === undefined) throw new Error("skin joint without a bone");
    return mul4(matrix(boneWorld[b], scale), glb.inverseBind.subarray(k * 16, k * 16 + 16));
  });
  const n = mesh.positions.length / 3;
  const out: V3[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const v = meshBind.apply(new V3(mesh.positions[3 * i], mesh.positions[3 * i + 1], mesh.positions[3 * i + 2]));
    let x = 0, y = 0, z = 0;
    for (let k = 0; k < 4; k++) {
      const w = mesh.weights[4 * i + k];
      if (w === 0) continue;
      const m = joint[mesh.joints[4 * i + k]];
      x += w * (m[0] * v.x + m[4] * v.y + m[8] * v.z + m[12]);
      y += w * (m[1] * v.x + m[5] * v.y + m[9] * v.z + m[13]);
      z += w * (m[2] * v.x + m[6] * v.y + m[10] * v.z + m[14]);
    }
    out[i] = new V3(x, y, z);
  }
  return out;
}
