import { describe, expect, it } from "vitest";
import { V3 } from "../../core/spatial";
import { CourtCalibration } from "../../core/video";

/**
 * A club's own camera: on a tripod about 2.5 m up, well behind our end line (OK Hoče - OK Triglav Kranj, Slovenian
 * league 2016-17, Wikimedia Commons, CC BY 3.0, 1280 x 720). Their end line sits squeezed behind the net and the
 * players, so the coach marks our half ("Our half" in the import): our corners and where the net meets the
 * sidelines, measured on the clip's clean plate.
 */
describe("Video to 3D: our half from a low end-line camera", () => {
  const ours = [{ x: 13, y: 695 }, { x: 1272, y: 692 }], net = [{ x: 943, y: 550 }, { x: 164, y: 550 }];

  it("finds the camera from our half alone", () => {
    const r = CourtCalibration.solveNearHalf(ours, net, "home", 1280, 720)!;
    expect(r).toBeDefined();
    expect(r.quality).not.toBe("failed");
    const cam = r.camera;
    expect(cam.center.y).toBeGreaterThan(2);
    expect(cam.center.y).toBeLessThan(3.5);
    expect(Math.abs(cam.center.z)).toBeGreaterThan(18);
    // Points it was not given: their left corner (seen on the clean plate) and the net tape over the left sideline.
    const left = cam.project(new V3(-4.5, 0, 0))!.x < 640 ? -4.5 : 4.5;
    const far = cam.project(new V3(left, 0, -9))!, tape = cam.project(new V3(left, 2.43, 0))!;
    expect(Math.hypot(far.x - 231, far.y - 479)).toBeLessThan(8);
    expect(Math.hypot(tape.x - 168, tape.y - 332)).toBeLessThan(6);
  });
});
