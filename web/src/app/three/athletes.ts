import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { AthleteRigs, poseAthlete, type AthletePose, type AthleteRig, type PosedPlayer } from "../../core/spatial";

/**
 * The 3D players as real people: MakeHuman athletes (CC0 bodies, built by web/tools/athletes/make_athlete.py), a woman
 * and a man, rigged for game engines. Every player is a clone of one, posed by the core (athleteBody.ts): the same
 * numbers keep the bodies apart, so what is drawn is what the separation sees.
 */

export interface AthleteColors {
  jersey: string;
  shorts: string;
  /** Multiplies the skin texture (white keeps it). */
  skin?: string;
  /** Multiplies the hair texture (white keeps it). */
  hair?: string;
}

export interface AthleteTemplate {
  scene: THREE.Object3D;
  rig: AthleteRig;
  /** The shirt fabric's typical brightness (linear): the team colour is divided by it, so the fabric shows that colour. */
  shirtTone: number;
}

/** The median brightness of a texture (linear luminance), from a small copy of it; 1 when it cannot be read. */
function typicalTone(image: CanvasImageSource): number {
  try {
    const n = 64;
    const cv = document.createElement("canvas");
    cv.width = cv.height = n;
    const g = cv.getContext("2d", { willReadFrequently: true })!;
    g.drawImage(image, 0, 0, n, n);
    const px = g.getImageData(0, 0, n, n).data;
    const lin = (c: number) => { const x = c / 255; return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
    const values: number[] = [];
    for (let i = 0; i < px.length; i += 4) if (px[i + 3] > 128) values.push(0.2126 * lin(px[i]) + 0.7152 * lin(px[i + 1]) + 0.0722 * lin(px[i + 2]));
    values.sort((a, b) => a - b);
    const median = values[Math.floor(values.length / 2)];
    return median > 0.02 ? median : 1;
  } catch {
    return 1;
  }
}

function prepare(scene: THREE.Object3D, rig: AthleteRig): AthleteTemplate {
  let shirtTone = 1;
  const names = new Set<string>();
  scene.traverse((o) => {
    if ((o as THREE.Bone).isBone) names.add(o.name);
    const m = o as THREE.SkinnedMesh;
    const mat = m.isSkinnedMesh ? (m.material as THREE.MeshStandardMaterial) : undefined;
    if (mat?.name === "Shirt" && mat.map?.image) shirtTone = typicalTone(mat.map.image as CanvasImageSource);
  });
  // The measured rig must belong to this model (fit_bodies.ts is run after every export).
  const missing = rig.bones.filter((b) => !names.has(b.name));
  if (missing.length) throw new Error(`athlete ${rig.name}: the model lacks ${missing.map((b) => b.name).join(", ")}`);
  return { scene, rig, shirtTone };
}

let loading: Promise<{ female: AthleteTemplate; male: AthleteTemplate }> | undefined;

/** Both athletes, loaded once (the app caches the files for offline use). */
export function loadAthletes(): Promise<{ female: AthleteTemplate; male: AthleteTemplate }> {
  loading ??= (async () => {
    const loader = new GLTFLoader();
    const base = import.meta.env.BASE_URL;
    const [female, male] = await Promise.all([
      loader.loadAsync(`${base}athletes/female.glb`), loader.loadAsync(`${base}athletes/male.glb`),
    ]);
    return { female: prepare(female.scene, AthleteRigs.female), male: prepare(male.scene, AthleteRigs.male) };
  })();
  loading.catch(() => { loading = undefined; });
  return loading;
}

/**
 * Opaque materials (the export marks every material as blended); hair, brows and lashes cut out along their alpha
 * (smoothed by the multisampling); the kit (jersey, shorts, pads and socks) drawn on both sides, so its inside shows
 * through a sleeve or a hem. Their textures carry the baked shading (folds, creases, the collar and cuffs).
 */
function material(source: THREE.Material): THREE.MeshStandardMaterial {
  const s = source as THREE.MeshStandardMaterial;
  const name = s.name;
  const cutout = name === "Hair" || name === "Eyebrows" || name === "Eyelashes";
  const cloth = name === "Shirt" || name === "Shorts" || name === "Gear";
  return new THREE.MeshStandardMaterial({
    name,
    map: s.map,
    normalMap: s.normalMap,
    color: 0xffffff,
    roughness: name === "Skin" ? 0.62 : name === "Eyes" ? 0.2 : name === "Shoes" ? 0.6 : name === "Hair" ? 0.75 : cloth ? 0.88 : 0.85,
    metalness: 0,
    transparent: false,
    alphaTest: cutout ? 0.5 : 0,
    alphaToCoverage: cutout,
    side: cutout || cloth ? THREE.DoubleSide : THREE.FrontSide,
  });
}

/** One player's athlete: a clone of a template, posed from the board's skeleton. */
export class Athlete {
  readonly root: THREE.Object3D;
  /** The clone's bones in the rig's order. */
  private readonly bones: THREE.Bone[];
  private readonly materials = new Map<string, THREE.MeshStandardMaterial>();
  private colorKey = "";
  private posed?: AthletePose;

  constructor(readonly template: AthleteTemplate) {
    this.root = cloneSkinned(template.scene);
    const byName = new Map<string, THREE.Bone>();
    this.root.traverse((o) => {
      if ((o as THREE.Bone).isBone) byName.set(o.name, o as THREE.Bone);
      const m = o as THREE.SkinnedMesh;
      if (m.isSkinnedMesh) {
        m.material = material(Array.isArray(m.material) ? m.material[0] : m.material);
        const name = (m.material as THREE.Material).name;
        this.materials.set(name, m.material as THREE.MeshStandardMaterial);
        m.frustumCulled = false;
        // Eyes, brows and lashes add nothing to a shadow on the floor, only draw calls.
        m.castShadow = name !== "Eyes" && name !== "Eyebrows" && name !== "Eyelashes";
      }
    });
    this.bones = template.rig.bones.map((b) => byName.get(b.name)!);
  }

  dispose() {
    for (const m of this.materials.values()) m.dispose();
    this.root.removeFromParent();
  }

  set visible(v: boolean) {
    this.root.visible = v;
  }

  /** The shirt in the team colour, the shorts, the skin tone and the hair. */
  setColors(c: AthleteColors) {
    const key = [c.jersey, c.shorts, c.skin, c.hair].join();
    if (key === this.colorKey) return;
    this.colorKey = key;
    // Divided by the fabric's own tone (at most 3 times brighter), so the shirt shows the team colour, not a dimmer one.
    this.materials.get("Shirt")?.color.set(c.jersey).multiplyScalar(Math.min(3, 0.85 / this.template.shirtTone));
    this.materials.get("Shorts")?.color.set(c.shorts);
    this.materials.get("Skin")?.color.set(c.skin ?? "#ffffff");
    this.materials.get("Hair")?.color.set(c.hair ?? "#ffffff");
  }

  /** Poses the athlete like a posed board player (see poseAthlete). */
  pose(p: PosedPlayer) {
    const pose = poseAthlete(this.template.rig, p);
    this.posed = pose;
    pose.local.forEach((q, i) => this.bones[i]?.quaternion.set(q.x, q.y, q.z, q.w));
    this.root.scale.setScalar(pose.scale);
    this.root.position.set(pose.origin.x, pose.origin.y, pose.origin.z);
    this.root.updateMatrixWorld(true);
  }

  /** Where the shirt number goes: on the chest's front or back surface, facing out. */
  numberSpot(front: boolean): { position: THREE.Vector3; quaternion: THREE.Quaternion } | undefined {
    const pose = this.posed;
    if (!pose) return undefined;
    const rig = this.template.rig, i = rig.chestBone;
    const bone = pose.world[i];
    const [qx, qy, qz, qw] = rig.bindRotation[i];
    // The chest's turn since the bind pose (the model faces +Z there).
    const turn = new THREE.Quaternion(bone.rotation.x, bone.rotation.y, bone.rotation.z, bone.rotation.w)
      .multiply(new THREE.Quaternion(qx, qy, qz, qw).invert());
    const surface = new THREE.Vector3(0, front ? -0.03 : -0.05,
      (front ? rig.chestFront + 0.004 : rig.chestBack - 0.004) - rig.bindPosition[i][2]);
    const position = surface.multiplyScalar(pose.scale).applyQuaternion(turn)
      .add(new THREE.Vector3(bone.translation.x, bone.translation.y, bone.translation.z));
    const quaternion = turn.clone();
    if (!front) quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
    return { position, quaternion };
  }
}
