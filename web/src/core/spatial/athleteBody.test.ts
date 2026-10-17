import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SceneToken } from "../zones/tacticalScene";
import { athleteCapsules, poseAthlete } from "./athleteBody";
import { AthleteRigs } from "./athleteRigs";
import { skinnedPositions } from "./athleteSkin";
import { strideParams } from "./gait";
import { parseGlb } from "./glb";
import { Rigid, V3 } from "./math3d";
import { PosedPlayer } from "./povAnalysis";
import { PoseParams } from "./postureLibrary";
import { BodyMetrics, Joint, Posture, SkeletonModel } from "./skeleton";

const here = dirname(fileURLToPath(import.meta.url));
const postures: Posture[] = ["standing", "ready", "pass", "set", "attack", "block", "dig", "reach", "readyHigh", "lowDefence",
  "angledPass", "overheadPass", "sprawl", "backSet", "jumpSet", "approach", "armCock", "landing", "quickAttack", "blockReady",
  "blockLanding", "floatServe", "jumpServe", "cover"];

function segmentDistance(p: V3, a: V3, b: V3): number {
  const ab = b.sub(a), l2 = ab.dot(ab);
  const t = l2 > 0 ? Math.max(0, Math.min(1, p.sub(a).dot(ab) / l2)) : 0;
  return p.sub(a.add(ab.mul(t))).length;
}

describe("Athletes", () => {
  for (const name of ["female", "male"] as const) {
    const rig = AthleteRigs[name];
    const glb = parseGlb(readFileSync(join(here, "..", "..", "..", "public", "athletes", `${name}.glb`)));
    const order = rig.bones.map((b) => glb.nodes.findIndex((n) => n.name === b.name));

    it(`${name}: the measured rig belongs to the model`, () => {
      expect(order.every((i) => i >= 0)).toBe(true);
      // Standing, the athlete's pelvis is over the skeleton's and its feet are on the floor.
      const s = new SkeletonModel(new BodyMetrics(1.85));
      const token = SceneToken.create({ side: "home", label: "1", role: "OH1", point: { x: 2, z: 3 } });
      const p = new PosedPlayer(token, s, s.pose("standing", token.point, 0.4));
      const pose = poseAthlete(rig, p);
      const pelvis = pose.world[rig.bones.findIndex((b) => b.name === "pelvis")].translation;
      expect(Math.hypot(pelvis.x - p.joints[Joint.pelvis].translation.x, pelvis.z - p.joints[Joint.pelvis].translation.z)).toBeLessThan(1e-4);
      let lowest = Infinity;
      for (const m of glb.meshes) for (const v of skinnedPositions(glb, m, order, pose.world, pose.scale, Rigid.identity)) lowest = Math.min(lowest, v.y);
      expect(Math.abs(lowest)).toBeLessThan(0.002);
    });

    it(`${name}: the capsules enclose the whole body in every posture, at any stature, between postures too`, () => {
      let worst = -Infinity, at = "";
      for (const stature of [1.65, 2.05]) {
        const s = new SkeletonModel(new BodyMetrics(stature));
        const cases: [string, PoseParams | Posture, string][] = [];
        for (const role of ["OH1", "S", "L"]) {
          for (const p of postures) cases.push([`${role} ${p}`, p, role]);
          // Blends the fit did not see.
          for (let k = 0; k + 5 < postures.length; k += 3) {
            cases.push([`${role} ${postures[k]}~${postures[k + 5]}`,
              PoseParams.blend(Posture.params(postures[k], s, role), Posture.params(postures[k + 5], s, role), 0.35), role]);
          }
          // Running steps the fit did not see.
          for (const [speed, phase] of [[2.5, 0.5], [5.5, 2], [6.5, 4]]) {
            cases.push([`${role} running ${speed} m/s`,
              strideParams(Posture.params("ready", s, role), s, { forward: speed * 0.8, left: speed * 0.6, phase }), role]);
          }
        }
        for (const [label, what, role] of cases) {
          const token = SceneToken.create({ side: "home", label: "1", role, point: { x: 0, z: 0 } });
          const p = new PosedPlayer(token, s, s.pose(what, token.point, 0.9, 0, role));
          const pose = poseAthlete(rig, p);
          const caps = athleteCapsules(rig, p, pose);
          for (const m of glb.meshes) {
            for (const v of skinnedPositions(glb, m, order, pose.world, pose.scale, Rigid.identity)) {
              let inside = Infinity;
              for (const c of caps) inside = Math.min(inside, segmentDistance(v, c.a, c.b) - c.r);
              if (inside > worst) { worst = inside; at = `${stature} ${label} ${m.material}`; }
            }
          }
        }
      }
      // Within the capsules, with no more than a millimetre to spare taken from the fit's half-centimetre margin.
      expect(worst, at).toBeLessThanOrEqual(0.001);
    }, 120000);
  }
});
