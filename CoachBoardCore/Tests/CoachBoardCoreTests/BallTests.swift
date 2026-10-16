import XCTest
@testable import CoachBoardCore

final class BallTests: XCTestCase {
    func testDragDecelerationMatchesTheBlueprint() {
        // rho A / 2m is about 0.077 per metre; a 25 m/s ball with C_D 0.25 decelerates at about 12 m/s^2.
        XCTAssertEqual(BallFlight.k, 0.077, accuracy: 0.001)
        let a = BallFlight.acceleration(V3(25, 0, 0), aero: .float, axis: V3(0, 0, 1))
        XCTAssertEqual(-a.x, 12.0, accuracy: 0.1)
        XCTAssertEqual(a.y, -9.81, accuracy: 1e-9)
        // Topspin pushes a forward-moving ball down.
        let axis = BallFlight.spinAxis(heading: V3(0, 0, -1))
        XCTAssertLessThan(BallFlight.acceleration(V3(0, 0, -25), aero: .topspin, axis: axis).y, -9.81 - 5)
    }

    func testRK4MatchesTheVacuumParabola() {
        let vacuum = BallFlight.Aero(drag: 0, lift: 0)
        let samples = BallFlight.simulate(from: V3(0, 2, 0), velocity: V3(3, 6, 0), aero: vacuum) { $0.t >= 1.0 - 1e-9 }
        let end = samples.last!
        XCTAssertEqual(end.p.x, 3, accuracy: 1e-9)
        XCTAssertEqual(end.p.y, 2 + 6 - 0.5 * 9.81, accuracy: 1e-9)
    }

    func testAimedAttackLandsOnTargetAndClearsTheNet() throws {
        let contact = V3(0.5, 3.0, 0.6)
        let target = V3(-2, BallFlight.radius, -6.5)
        let t = try XCTUnwrap(FlightSolver.aim(from: contact, to: target, speed: 25, aero: .topspin))
        XCTAssertLessThan((t.end - target).length, 1e-9)
        // Re-fly the solved launch velocity without the solver: it lands within 3 cm of the target.
        let v0 = t.samples[0].v
        let check = BallFlight.simulate(from: contact, velocity: v0, aero: .topspin) { $0.p.y <= BallFlight.radius }
        let landed = check.last!.p
        XCTAssertLessThan(hypot(landed.x - target.x, landed.z - target.z), 0.03)
        let net = try XCTUnwrap(t.netCrossing(netHeight: 2.43))
        XCTAssertTrue(net.clears, "clearance \(net.clearance)")
        XCTAssertEqual(t.launchSpeed, 25, accuracy: 1e-6)
        // Out of reach at 4 m/s.
        XCTAssertNil(FlightSolver.aim(from: contact, to: V3(0, BallFlight.radius, -9), speed: 4, aero: .topspin))
    }

    func testLobHitsItsApexAndTarget() throws {
        let from = V3(2, 0.75, 5), to = V3(1.5, 2.1, 0.7)
        let t = try XCTUnwrap(FlightSolver.lob(from: from, to: to, apex: 2.43 + 2.0, aero: .soft))
        XCTAssertEqual(t.apex, 4.43, accuracy: 0.012)
        XCTAssertLessThan((t.end - to).length, 1e-9)
        XCTAssertGreaterThan(t.duration, 1.0)
        XCTAssertLessThan(t.duration, 2.5)
    }

    func testBallPlanChainsContactsThroughTheTimeline() throws {
        let server = SceneToken(side: .opponent, label: "S", role: "S", point: FloorPoint(x: 3, z: -10))
        let libero = SceneToken(side: .home, label: "2", role: "L", point: FloorPoint(x: 0, z: 6))
        let setter = SceneToken(side: .home, label: "8", role: "S", point: FloorPoint(x: 1.5, z: 0.7))
        let hitter = SceneToken(side: .home, label: "12", role: "OH1", point: FloorPoint(x: 4, z: 1))
        var scene = TacticalScene(title: "Rally", tokens: [server, libero, setter, hitter])
        scene.phases = RallyPhase.allCases
        scene.contacts = [BallContact(phase: .serve, player: server.id, kind: .floatServe),
                          BallContact(phase: .receive, player: libero.id, kind: .pass),
                          BallContact(phase: .set, player: setter.id, kind: .highSet),
                          BallContact(phase: .attack, player: hitter.id, kind: .attack)]
        let plan = scene.ballPlan()
        XCTAssertEqual(plan.segments.count, 4)
        XCTAssertTrue(plan.segments.allSatisfy { $0.trajectory != nil })
        // Each flight ends where the next contact begins, and the ball sits there at the marker.
        for k in 0..<3 {
            XCTAssertLessThan((plan.segments[k].trajectory!.end - plan.segments[k + 1].from).length, 1e-9)
            XCTAssertLessThan((plan.position(at: Double(k + 1))! - plan.segments[k + 1].from).length, 1e-6)
        }
        // The serve crosses the net; the attack lands deep in the far half by default.
        XCTAssertTrue(try XCTUnwrap(plan.segments[0].trajectory?.netCrossing(netHeight: 2.43)).clears)
        XCTAssertEqual(plan.segments[3].to.z, -6, accuracy: 1e-9)
        XCTAssertEqual(plan.segments[3].endTime, 4)
        XCTAssertTrue(plan.segments[3].summary(netHeight: 2.43).hasPrefix("#12 ATTACK \u{00B7} 25 m/s \u{00B7} "))
        // Mid-way through the set the ball is high above the tape.
        XCTAssertGreaterThan(plan.position(at: 2.5)!.y, 3.5)
        // Editor: one contact per marker, undoable.
        var e = SceneEditor(scene: scene)
        e.setContact(BallContact(phase: .set, player: setter.id, kind: .quickSet), at: .set)
        XCTAssertEqual(e.scene.contacts?.count, 4)
        XCTAssertEqual(e.scene.contacts?.first { $0.phase == .set }?.kind, .quickSet)
        e.setContact(nil, at: .attack)
        XCTAssertEqual(e.scene.contacts?.count, 3)
        e.undo(); e.undo()
        XCTAssertEqual(e.scene, scene)
    }
}
