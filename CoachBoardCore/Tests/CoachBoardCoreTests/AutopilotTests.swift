import XCTest
@testable import CoachBoardCore

final class AutopilotTests: XCTestCase {
    func testPlaceBothTeamsFromSetup() {
        let scene = TacticalScene.placed(title: "R1", setup: SceneSetup())
        XCTAssertEqual(scene.tokens.filter { $0.side == .home }.count, 6)
        XCTAssertEqual(scene.tokens.filter { $0.side == .opponent }.count, 6)
        // The opponent serves: its P1 stands behind the end line on its half.
        let server = scene.tokens.first { abs($0.point.z) > 9 }
        XCTAssertEqual(server?.side, .opponent)
        XCTAssertLessThan(server?.point.z ?? 0, -9)
        // Home receives in R1 with the libero on court.
        XCTAssertTrue(scene.tokens.contains { $0.side == .home && $0.role == "L" })
        XCTAssertTrue(scene.tokens.allSatisfy { $0.side == .home ? $0.point.z > 0 : $0.point.z < 0 })
    }

    func testRotateKeepsIdentityAndLabels() {
        var scene = TacticalScene.placed(title: "R1", setup: SceneSetup())
        let i = scene.tokens.firstIndex { $0.side == .home && $0.role == "OH1" }!
        scene.tokens[i].label = "7"
        let id = scene.tokens[i].id
        scene.rotate(.home)
        XCTAssertEqual(scene.setup?.homeRotation, 6)
        let oh1 = scene.tokens.first { $0.side == .home && $0.role == "OH1" }
        XCTAssertEqual(oh1?.id, id)
        XCTAssertEqual(oh1?.label, "7")
        // Six rotations bring the team back to R1.
        for _ in 0..<5 { scene.rotate(.home) }
        XCTAssertEqual(scene.setup?.homeRotation, 1)
        XCTAssertEqual(scene.tokens.first { $0.id == id }?.label, "7")
    }

    func testRotationCycles() throws {
        let sixTwo = try TemplateLibrary.template(id: TeamSystem.sixTwo.rawValue)
        XCTAssertEqual(sixTwo.nextRotation(after: 1), 6)
        XCTAssertEqual(sixTwo.nextRotation(after: 5), 1)
        let fourTwo = try TemplateLibrary.template(id: TeamSystem.fourTwo.rawValue)
        XCTAssertEqual(fourTwo.nextRotation(after: 4), 3)
        XCTAssertEqual(fourTwo.nextRotation(after: 2), 4)
        XCTAssertEqual(fourTwo.previousRotation(before: 4), 2)
        let youth = try TemplateLibrary.template(id: TeamSystem.youthW.rawValue)
        XCTAssertEqual(youth.nextRotation(after: 0), 0)
    }

    func testEverySystemPlacesSixAndSix() {
        for system in TeamSystem.allCases {
            let t = try? TemplateLibrary.template(id: system.templateID)
            let r = t?.rotations.first ?? 1
            for serves in [false, true] {
                let setup = SceneSetup(homeSystem: system.rawValue, homeRotation: r, homeServes: serves)
                let scene = TacticalScene.placed(title: system.displayName, setup: setup)
                XCTAssertEqual(scene.tokens.filter { $0.side == .home }.count, 6, "\(system) serves \(serves)")
                XCTAssertEqual(scene.tokens.filter { $0.side == .opponent }.count, 6)
            }
        }
    }

    func testPlayOutBuildsARally() {
        for attack in AttackOption.allCases {
            for homeServes in [false, true] {
                var scene = TacticalScene.placed(title: "rally", setup: SceneSetup(homeServes: homeServes))
                scene.playOut(attack)
                XCTAssertEqual(scene.timeline, RallyPhase.allCases)
                XCTAssertEqual(scene.contacts?.map(\.phase), [.serve, .receive, .set, .attack, .cover], "\(attack)")
                let plan = scene.ballPlan()
                XCTAssertEqual(plan.segments.count, 5)
                XCTAssertTrue(plan.segments.allSatisfy { $0.trajectory != nil }, "\(attack) \(homeServes)")
                // The serve and the attack cross the net above the tape.
                for k in [0, 3] {
                    let crossing = plan.segments[k].trajectory?.netCrossing(netHeight: 2.43)
                    XCTAssertNotNil(crossing, "\(attack) segment \(k)")
                    XCTAssertTrue(crossing?.clears ?? false, "\(attack) \(homeServes) segment \(k): \(String(describing: crossing))")
                }
                // Players stay on their own side at every marker and never stand inside each other.
                for m in 0..<6 {
                    let f = scene.frame(at: Double(m))
                    for t in f.tokens {
                        XCTAssertTrue(t.side == .home ? t.point.z > 0 : t.point.z < 0, "\(t.role) at \(m)")
                    }
                    for side in Side.allCases {
                        let pts = f.tokens.filter { $0.side == side }.map(\.point)
                        for a in pts.indices { for b in pts.indices where b > a {
                            XCTAssertGreaterThan(hypot(pts[a].x - pts[b].x, pts[a].z - pts[b].z), 0.3, "\(attack) marker \(m)")
                        } }
                    }
                }
            }
        }
    }

    func testWomensRallyClearsTheLowerNet() {
        PlayerBodies.women = true
        defer { PlayerBodies.women = false }
        XCTAssertEqual(PlayerBodies.netHeight, 2.24)
        XCTAssertEqual(SceneToken.defaultStature(role: "MB1"), 1.90, accuracy: 1e-9)
        for attack in AttackOption.allCases {
            var scene = TacticalScene.placed(title: "women", setup: SceneSetup())
            scene.playOut(attack)
            let plan = scene.ballPlan(netHeight: PlayerBodies.netHeight)
            for k in [0, 3] {
                let crossing = plan.segments[k].trajectory?.netCrossing(netHeight: PlayerBodies.netHeight)
                XCTAssertTrue(crossing?.clears ?? false, "\(attack) segment \(k): \(String(describing: crossing))")
            }
        }
    }

    func testPlayersFaceTheBall() {
        var scene = TacticalScene.placed(title: "rally", setup: SceneSetup())
        scene.playOut(.left)
        let plan = scene.ballPlan()
        let t = 0.5
        let ball = plan.position(at: t)!
        let f = scene.liveFrame(at: t, plan: plan)
        for token in f.tokens where token.side == .home {
            let want = atan2(ball.x - token.point.x, ball.z - token.point.z)
            var d = abs((token.facing - want).truncatingRemainder(dividingBy: 2 * .pi))
            if d > .pi { d = 2 * .pi - d }
            XCTAssertLessThan(d, 0.05, token.role)
        }
        // Without a ball the receivers face the server.
        let still = TacticalScene.placed(title: "still", setup: SceneSetup()).liveFrame(at: 0)
        let server = still.tokens.first { abs($0.point.z) > 9 }!
        let receiver = still.tokens.first { $0.side == .home }!
        XCTAssertEqual(receiver.facing, atan2(server.point.x - receiver.point.x, server.point.z - receiver.point.z), accuracy: 1e-9)
        // An explicit facing wins.
        var turned = scene
        turned.tokens[0].yaw = 1.0
        XCTAssertEqual(turned.liveFrame(at: t, plan: plan).tokens[0].facing, 1.0)
    }

    func testPlacementAssistSnapsAndSeparates() {
        let scene = TacticalScene.placed(title: "snap", setup: SceneSetup())
        let spots = PlacementAssist.spots(for: .home, setup: scene.setup)
        XCTAssertFalse(spots.isEmpty)
        let base = CourtFrame.world(LocalPoint(l: 4.5, d: 8.0), of: .home)
        let mover = scene.tokens.first { $0.side == .home }!
        let others = scene.tokens.filter { $0.id != mover.id && hypot($0.point.x - base.x, $0.point.z - base.z) > 1 }
        let r = PlacementAssist.adjust(FloorPoint(x: base.x + 0.2, z: base.z - 0.1), token: mover.id, side: .home, others: others, spots: spots)
        XCTAssertEqual(r.snapped, base)
        // Dropped on top of a teammate: nudged out to the minimum separation.
        let mate = scene.tokens.first { $0.side == .home && $0.id != mover.id }!
        let pushed = PlacementAssist.adjust(FloorPoint(x: mate.point.x + 0.1, z: mate.point.z), token: mover.id, side: .home,
                                            others: [mate], spots: [])
        XCTAssertGreaterThanOrEqual(hypot(pushed.point.x - mate.point.x, pushed.point.z - mate.point.z), PlacementAssist.minSeparation - 1e-9)
    }

    func testSceneWithSetupRoundTripsAndOldFilesStillLoad() throws {
        var scene = TacticalScene.placed(title: "codable", setup: SceneSetup(homeRotation: 4, homeServes: true, attack: .back))
        scene.tokens[0].yaw = 0.5
        let data = try JSONEncoder().encode(scene)
        let back = try JSONDecoder().decode(TacticalScene.self, from: data)
        XCTAssertEqual(back, scene)
        var old = TacticalScene(title: "old")
        old.tokens = [SceneToken(side: .home, label: "1", role: "S", point: FloorPoint(x: 0, z: 3))]
        var json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(old)) as! [String: Any]
        json["setup"] = nil
        let decoded = try JSONDecoder().decode(TacticalScene.self, from: JSONSerialization.data(withJSONObject: json))
        XCTAssertNil(decoded.setup)
        XCTAssertNil(decoded.tokens[0].yaw)
    }

    func testEditorAutopilotIsOneUndoStep() {
        var editor = SceneEditor(scene: TacticalScene.placed(title: "undo", setup: SceneSetup()))
        let before = editor.scene
        editor.playOut(.middle)
        XCTAssertEqual(editor.scene.timeline.count, 6)
        editor.undo()
        XCTAssertEqual(editor.scene, before)
        editor.rotate(.home)
        XCTAssertEqual(editor.scene.setup?.homeRotation, 6)
    }
}
