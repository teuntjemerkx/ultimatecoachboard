import * as THREE from "three";
import type { VideoScene } from "../../core/video";

const vertexShader = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

// Where the video saw the wall, its pixels; where it did not, the mirror image across the court's middle (halls are
// close to symmetric), slightly darker; otherwise the hall colour, darkening toward the ceiling. A point counts as
// seen only when the camera's ray meets its wall from inside the hall and, above the floor, then lands on the floor
// outside the hall: from a camera in the stands the mirror image of the far wall falls between the camera and the
// court, where the video shows the court or the far stands behind it.
const fragmentShader = /* glsl */ `
uniform sampler2D plate;
uniform bool hasPlate;
uniform mat4 worldToImage;
uniform vec3 camera;
uniform vec2 hallHalf;
uniform vec3 fallback;
uniform float brightness;
uniform float height;
varying vec3 vWorld;

bool plateUV(vec3 p, out vec2 uv) {
  vec4 q = worldToImage * vec4(p, 1.0);
  uv = vec2(0.0);
  if (q.w <= 1e-4) return false;
  uv = q.xy / q.w;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return false;
  vec3 d = p - camera;
  if (abs(p.x) >= hallHalf.x - 0.01 && d.x * sign(p.x) <= 0.0) return false;
  if (abs(p.z) >= hallHalf.y - 0.01 && d.z * sign(p.z) <= 0.0) return false;
  if (p.y < 0.02) return abs(p.x) <= hallHalf.x + 0.01 && abs(p.z) <= hallHalf.y + 0.01;
  if (d.y >= 0.0) return true;
  vec3 hit = camera + d * (-camera.y / d.y);
  return abs(hit.x) > hallHalf.x || abs(hit.z) > hallHalf.y;
}

void main() {
  vec3 p = vWorld;
  vec4 color = vec4(fallback * (1.0 - 0.35 * clamp(p.y / max(height, 1.0), 0.0, 1.0)), 1.0);
  if (hasPlate) {
    for (int i = 0; i < 4; i++) {
      vec3 q = i == 0 ? p : i == 1 ? vec3(-p.x, p.y, p.z) : i == 2 ? vec3(p.x, p.y, -p.z) : vec3(-p.x, p.y, -p.z);
      vec2 uv;
      if (plateUV(q, uv)) {
        color = vec4(texture2D(plate, vec2(uv.x, 1.0 - uv.y)).rgb * brightness * (i == 0 ? 1.0 : 0.82), 1.0);
        break;
      }
    }
  }
  gl_FragColor = color;
  #include <colorspace_fragment>
}`;

/**
 * The hall of a video scene around the 3D board (Section 4.5): walls, ceiling and the hall floor beyond the board's
 * floor, painted from the clean plate through the calibrated video camera (a projective texture). Faces point
 * inward and the back sides are culled, so from the orbit camera the hall opens like a doll's house and from a
 * player's eyes it closes all round. The box always holds the video camera: a wall between the camera and the court
 * would be painted with the court.
 */
export class Hall3D {
  readonly mesh: THREE.Mesh;
  private texture?: THREE.Texture;
  private disposed = false;

  constructor(private readonly root: THREE.Object3D, video: VideoScene, plateURL: string | undefined, hallColor: string) {
    const env = video.environment, c = video.camera.center;
    const x0 = Math.min(-env.halfWidth, c.x - 1.5), x1 = Math.max(env.halfWidth, c.x + 1.5);
    const z0 = Math.min(-env.halfLength, c.z - 1.5), z1 = Math.max(env.halfLength, c.z + 1.5);
    const h = Math.max(env.height, c.y + 1.5);
    const verts: number[] = [];
    /** A quad wound so its front faces `inward`. */
    const quad = (a: number[], b: number[], cc: number[], d: number[], inward: [number, number, number]) => {
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [cc[0] - a[0], cc[1] - a[1], cc[2] - a[2]];
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const flip = n[0] * inward[0] + n[1] * inward[1] + n[2] * inward[2] < 0;
      const tri = flip ? [a, cc, b, a, d, cc] : [a, b, cc, a, cc, d];
      for (const p of tri) verts.push(p[0], p[1], p[2]);
    };
    quad([x1, 0, z0], [x1, 0, z1], [x1, h, z1], [x1, h, z0], [-1, 0, 0]);
    quad([x0, 0, z0], [x0, 0, z1], [x0, h, z1], [x0, h, z0], [1, 0, 0]);
    quad([x0, 0, z1], [x1, 0, z1], [x1, h, z1], [x0, h, z1], [0, 0, -1]);
    quad([x0, 0, z0], [x1, 0, z0], [x1, h, z0], [x0, h, z0], [0, 0, 1]);
    quad([x0, h, z0], [x1, h, z0], [x1, h, z1], [x0, h, z1], [0, -1, 0]);
    // The hall floor beyond the board's floor (x within +-10, z within +-17), where the hall is bigger.
    const fw = 10, fl = 17;
    if (z1 > fl) quad([x0, 0, fl], [x1, 0, fl], [x1, 0, z1], [x0, 0, z1], [0, 1, 0]);
    if (z0 < -fl) quad([x0, 0, z0], [x1, 0, z0], [x1, 0, -fl], [x0, 0, -fl], [0, 1, 0]);
    const zz0 = Math.max(z0, -fl), zz1 = Math.min(z1, fl);
    if (x1 > fw) quad([fw, 0, zz0], [x1, 0, zz0], [x1, 0, zz1], [fw, 0, zz1], [0, 1, 0]);
    if (x0 < -fw) quad([x0, 0, zz0], [-fw, 0, zz0], [-fw, 0, zz1], [x0, 0, zz1], [0, 1, 0]);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    const m = video.camera.normalizedProjection;
    const worldToImage = new THREE.Matrix4().set(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], 0, 0, 0, 0, m[8], m[9], m[10], m[11]);
    const material = new THREE.ShaderMaterial({
      vertexShader, fragmentShader, side: THREE.FrontSide,
      uniforms: {
        plate: { value: null }, hasPlate: { value: false }, worldToImage: { value: worldToImage },
        camera: { value: new THREE.Vector3(c.x, c.y, c.z) }, hallHalf: { value: new THREE.Vector2(env.halfWidth, env.halfLength) },
        fallback: { value: new THREE.Color(hallColor) }, brightness: { value: 0.92 }, height: { value: h },
      },
    });
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = "hall";
    this.mesh.frustumCulled = false;
    root.add(this.mesh);
    if (plateURL) {
      new THREE.TextureLoader().load(plateURL, (tex) => {
        if (this.disposed) { tex.dispose(); return; }
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.minFilter = THREE.LinearFilter;
        tex.generateMipmaps = false;
        this.texture = tex;
        material.uniforms.plate.value = tex;
        material.uniforms.hasPlate.value = true;
      });
    }
  }

  dispose() {
    this.disposed = true;
    this.root.remove(this.mesh);
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.texture?.dispose();
  }
}
