import XCTest
import Foundation
@testable import CoachBoardCore

/// Writes skinned avatar meshes for offline previews (Verification/preview_avatars.py) when EXPORT_AVATARS names a
/// directory; otherwise does nothing.
final class AvatarExportTests: XCTestCase {
    func testExportPosedAvatars() throws {
        guard let dir = ProcessInfo.processInfo.environment["EXPORT_AVATARS"] else { return }
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let roles = ProcessInfo.processInfo.environment["EXPORT_ROLES"]?.split(separator: ",").map(String.init) ?? ["OH1"]
        let postures = ProcessInfo.processInfo.environment["EXPORT_POSTURES"]?.split(separator: ",").compactMap { Posture(rawValue: String($0)) }
            ?? Posture.allCases
        for role in roles {
            let s = SkeletonModel(BodyMetrics(stature: SceneToken.defaultStature(role: role)))
            let mesh = AvatarMesh(skeleton: s)
            for posture in postures {
                let posed = s.pose(posture, position: FloorPoint(x: 0, z: 0), facing: 0, role: role)
                let dqs = s.skin(posed)
                var verts: [Double] = [], norms: [Double] = []
                for i in mesh.positions.indices {
                    let (j0, j1) = mesh.joints[i], (w0, w1) = mesh.weights[i]
                    let dq = DualQuat.blend([(dqs[j0], w0), (dqs[j1], w1)])
                    let p = dq.transform(mesh.positions[i]), n = dq.real.rotate(mesh.normals[i])
                    verts += [p.x, p.y, p.z]
                    norms += [n.x, n.y, n.z]
                }
                let out: [String: Any] = ["role": role, "posture": posture.rawValue, "stature": s.metrics.stature,
                                          "jump": posture.params(for: s, role: role).jump,
                                          "vertices": verts, "normals": norms, "materials": mesh.materials.map { Int($0.rawValue) },
                                          "indices": mesh.indices.map { Int($0) }]
                let data = try JSONSerialization.data(withJSONObject: out)
                try data.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(role)_\(posture.rawValue).json"))
            }
        }
    }
}
