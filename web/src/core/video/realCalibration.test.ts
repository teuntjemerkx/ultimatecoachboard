// Port of CoachBoardCoreTests/RealCalibrationTests.swift.
import { describe, expect, it } from "vitest";
import { V3 } from "../spatial/math3d";
import { expectClose } from "../spatial/testSupport";
import { CourtCalibration } from "./courtCalibration";

/**
 * Calibration on a real broadcast frame (Tokyo 2020, 600 x 338, filmed from behind an end line): the four corners a
 * coach would mark were measured on the frame, and so were lines the calibration never saw.
 */
describe("RealCalibrationTests", () => {
  it("four corners predict the rest of the court", () => {
    const r = CourtCalibration.solveCorners([{ x: 51.5, y: 331 }, { x: 554.2, y: 331 }], [{ x: 142.0, y: 136.5 }, { x: 463.5, y: 136.5 }], 600, 338)!;
    expect(r).toBeDefined();
    // A broadcast telephoto in the stands is a good fit, not a rough one.
    expect(r.quality).toBe("good");
    const cam = r.camera;
    expectClose(cam.center.y, 9.4, 1.5);
    expect(cam.center.z).toBeGreaterThan(25);
    // Measured on the frame: attack lines at y 183 and 245, the centre line (post feet) at 213, the tape at 107.
    expectClose(cam.project(new V3(0, 0, -3))!.y, 183, 3);
    expectClose(cam.project(new V3(0, 0, 3))!.y, 245, 3);
    expectClose(cam.project(new V3(0, 0, 0))!.y, 213, 3);
    expectClose(cam.project(new V3(0, 2.43, 0))!.y, 107, 3);
  });
});
