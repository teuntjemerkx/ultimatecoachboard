// Web addition: a minimal reader for the skinned GLB files of the athletes (glTF 2.0 binary): the node tree with its
// transforms, the skin (joint nodes and inverse bind matrices) and every skinned mesh's positions, joints and weights.
// Used offline by web/tools/athletes/fit_bodies.ts and by the tests; the app itself loads the files with three.js.

export interface GlbNode {
  name: string;
  parent: number;
  children: number[];
  translation: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
}

export interface GlbSkinnedMesh {
  /** The material's name (Skin, Shirt, Shorts, Shoes, Hair, Eyes, Eyebrows, Eyelashes). */
  material: string;
  positions: Float32Array;
  /** Four skin joint indices per vertex (into GlbSkin.joints). */
  joints: Uint16Array;
  weights: Float32Array;
}

export interface GlbSkinned {
  nodes: GlbNode[];
  /** Node index of each skin joint. */
  skinJoints: number[];
  /** Inverse bind matrix of each skin joint, column-major, 16 numbers each. */
  inverseBind: Float32Array;
  meshes: GlbSkinnedMesh[];
}

interface Accessor { bufferView: number; byteOffset?: number; componentType: number; count: number; type: string }
interface BufferView { byteOffset?: number; byteLength: number; byteStride?: number }

const components: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

/** Reads a GLB file. Throws on anything that is not a single-skin binary glTF 2.0. */
export function parseGlb(data: ArrayBuffer | Uint8Array): GlbSkinned {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error("not a GLB file");
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)));
  const binStart = 20 + jsonLength + 8;
  const bin = bytes.subarray(binStart, binStart + view.getUint32(20 + jsonLength, true));
  const binView = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const accessors: Accessor[] = json.accessors, views: BufferView[] = json.bufferViews;

  const read = (index: number): number[] => {
    const a = accessors[index], v = views[a.bufferView];
    const n = components[a.type];
    const size = a.componentType === 5126 ? 4 : a.componentType === 5123 ? 2 : 1;
    const stride = v.byteStride ?? n * size;
    const base = (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const out = new Array<number>(a.count * n);
    for (let i = 0; i < a.count; i++) {
      for (let k = 0; k < n; k++) {
        const at = base + i * stride + k * size;
        out[i * n + k] = a.componentType === 5126 ? binView.getFloat32(at, true)
          : a.componentType === 5123 ? binView.getUint16(at, true) : binView.getUint8(at);
      }
    }
    return out;
  };

  const nodes: GlbNode[] = json.nodes.map((n: Record<string, unknown>) => ({
    name: (n.name as string) ?? "", parent: -1, children: (n.children as number[]) ?? [],
    translation: (n.translation as [number, number, number]) ?? [0, 0, 0],
    rotation: (n.rotation as [number, number, number, number]) ?? [0, 0, 0, 1],
    scale: (n.scale as [number, number, number]) ?? [1, 1, 1],
  }));
  nodes.forEach((n, i) => { for (const c of n.children) nodes[c].parent = i; });
  if (!json.skins || json.skins.length !== 1) throw new Error("expected one skin");
  const skin = json.skins[0];
  const meshes: GlbSkinnedMesh[] = [];
  for (const node of json.nodes as Record<string, unknown>[]) {
    if (node.mesh === undefined || node.skin === undefined) continue;
    for (const prim of json.meshes[node.mesh as number].primitives) {
      const material = prim.material !== undefined ? json.materials[prim.material].name : "";
      meshes.push({
        material,
        positions: Float32Array.from(read(prim.attributes.POSITION)),
        joints: Uint16Array.from(read(prim.attributes.JOINTS_0)),
        weights: Float32Array.from(read(prim.attributes.WEIGHTS_0)),
      });
    }
  }
  return { nodes, skinJoints: skin.joints, inverseBind: Float32Array.from(read(skin.inverseBindMatrices)), meshes };
}
