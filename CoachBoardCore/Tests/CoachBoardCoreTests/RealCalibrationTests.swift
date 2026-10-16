import XCTest
@testable import CoachBoardCore

/// Calibration on a real broadcast frame (Tokyo 2020, 600 x 338, filmed from behind an end line): the four corners a
/// coach would mark were measured on the frame, and so were lines the calibration never saw.
final class RealCalibrationTests: XCTestCase {
    func testFourCornersPredictTheRestOfTheCourt() throws {
        let r = try XCTUnwrap(CourtCalibration.solveCorners(ourEnd: [ImagePoint(x: 51.5, y: 331), ImagePoint(x: 554.2, y: 331)],
                                                            theirEnd: [ImagePoint(x: 142.0, y: 136.5), ImagePoint(x: 463.5, y: 136.5)],
                                                            imageWidth: 600, imageHeight: 338))
        // A broadcast telephoto in the stands is a good fit, not a rough one.
        XCTAssertEqual(r.quality, .good)
        let cam = r.camera
        XCTAssertEqual(cam.center.y, 9.4, accuracy: 1.5)
        XCTAssertGreaterThan(cam.center.z, 25)
        // Measured on the frame: attack lines at y 183 and 245, the centre line (post feet) at 213, the tape at 107.
        XCTAssertEqual(try XCTUnwrap(cam.project(V3(0, 0, -3))).y, 183, accuracy: 3)
        XCTAssertEqual(try XCTUnwrap(cam.project(V3(0, 0, 3))).y, 245, accuracy: 3)
        XCTAssertEqual(try XCTUnwrap(cam.project(V3(0, 0, 0))).y, 213, accuracy: 3)
        XCTAssertEqual(try XCTUnwrap(cam.project(V3(0, 2.43, 0))).y, 107, accuracy: 3)
    }
}
