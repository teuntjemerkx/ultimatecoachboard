import XCTest
import Foundation
@testable import CoachBoardCore

/// Writes skinned avatar meshes for offline previews (Verification/preview_avatars.py) when EXPORT_AVATARS names a
/// directory; otherwise does nothing.
final class AvatarExportTests: XCTestCase {
    func testExportPosedAvatars() throws {
        guard let dir = ProcessInfo.processInfo.environment["EXPORT_AVATARS"] else { return }
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        if let positions = ProcessInfo.processInfo.environment["EXPORT_LIBRARY"] {
            // Every research technique of the named positions ("all" for every position), in its own variant.
            let roleFor = ["setter": "S", "outside_hitter": "OH1", "opposite": "OPP", "middle_blocker": "MB1", "libero": "L"]
            for (position, entry) in PostureLibrary.shared.positions where positions == "all" || positions.split(separator: ",").contains(Substring(position)) {
                let role = roleFor[position] ?? "OH1"
                let s = SkeletonModel(BodyMetrics(stature: SceneToken.defaultStature(role: role)))
                let mesh = AvatarMesh(skeleton: s)
                for (i, spec) in entry.techniques.enumerated() {
                    let params = spec.params(for: s)
                    try write(s, mesh, s.pose(params, position: FloorPoint(x: 0, z: 0), facing: 0), role: role,
                              name: String(format: "%@_%02d_%@", position, i, spec.id), label: spec.id, jump: params.jump, dir: dir)
                }
            }
            return
        }
        let roles = ProcessInfo.processInfo.environment["EXPORT_ROLES"]?.split(separator: ",").map(String.init) ?? ["OH1"]
        let postures = ProcessInfo.processInfo.environment["EXPORT_POSTURES"]?.split(separator: ",").compactMap { Posture(rawValue: String($0)) }
            ?? Posture.allCases
        for role in roles {
            let s = SkeletonModel(BodyMetrics(stature: SceneToken.defaultStature(role: role)))
            let mesh = AvatarMesh(skeleton: s)
            for posture in postures {
                try write(s, mesh, s.pose(posture, position: FloorPoint(x: 0, z: 0), facing: 0, role: role), role: role,
                          name: "\(role)_\(posture.rawValue)", label: posture.rawValue, jump: posture.params(for: s, role: role).jump, dir: dir)
            }
        }
    }

    private func write(_ s: SkeletonModel, _ mesh: AvatarMesh, _ posed: [Rigid], role: String, name: String, label: String,
                       jump: Double, dir: String) throws {
        let dqs = s.skin(posed)
        var verts: [Double] = [], norms: [Double] = []
        for i in mesh.positions.indices {
            let (j0, j1) = mesh.joints[i], (w0, w1) = mesh.weights[i]
            let dq = DualQuat.blend([(dqs[j0], w0), (dqs[j1], w1)])
            let p = dq.transform(mesh.positions[i]), n = dq.real.rotate(mesh.normals[i])
            verts += [p.x, p.y, p.z]
            norms += [n.x, n.y, n.z]
        }
        let jointsOut = Joint.allCases.map { j -> [Double] in let t = posed[j.rawValue].translation; return [t.x, t.y, t.z] }
        let tips = [s.fingertip(posed, left: true), s.fingertip(posed, left: false)].map { [$0.x, $0.y, $0.z] }
        let out: [String: Any] = ["role": role, "posture": label, "stature": s.metrics.stature, "jump": jump,
                                  "joints": jointsOut, "fingertips": tips, "eye": { let e = s.eye(posed); return [e.x, e.y, e.z] }(),
                                  "vertices": verts, "normals": norms, "materials": mesh.materials.map { Int($0.rawValue) },
                                  "indices": mesh.indices.map { Int($0) }]
        let data = try JSONSerialization.data(withJSONObject: out)
        try data.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).json"))
    }
}
