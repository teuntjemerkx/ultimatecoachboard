import UIKit
import CoachBoardCore

/// Launch-argument demo states (`-demoScreen launcher|setup|live|advanced|setbreak|log|studio|studio3d|pov|rally|rallyeye|videomark|videowatch|video3d|videoeye|gallery`) so CI can capture screenshots of
/// real screens in the Simulator. Only reachable through launch arguments; never shown to a coach.
enum DemoMode {
    static var screen: String? {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-demoScreen"), args.indices.contains(i + 1) else { return nil }
        return args[i + 1]
    }

    static var setup: MatchSetupData {
        var s = MatchSetupData()
        s.homeName = "Orion"
        s.opponentName = "Dynamo"
        let numbers = [8, 12, 4, 9, 14, 2]           // P1...P6 with the setter (#8) in P1
        s.homeSlots = numbers.map { SlotPlayer(id: UUID(), jersey: $0, name: nil) }
        s.homeLibero = SlotPlayer(id: UUID(), jersey: 6, name: nil)
        s.setterPosition = 1
        s.opponentNumbers = [3, 11, 7, 10, 5, 1]
        s.opponentSetterPosition = 1
        s.firstServer = .opponent
        return s
    }

    /// Prepares the requested state on the model.
    @MainActor
    static func apply(to model: AppModel) {
        guard let screen else { return }
        note("demo screen \(screen)")
        switch screen {
        case "setup":
            model.screen = .setup
        case "live":
            guard let c = try? LiveController(setup: setup) else { return }
            play(c, rallies: [.home, .home, .opponent, .home], scout: true)
            c.routesVisible = true
            model.screen = .live(c)
        case "advanced":
            var s = setup
            s.mode = .advanced
            guard let c = try? LiveController(setup: s) else { return }
            codeRally(c, winner: .home)
            codeRally(c, winner: .opponent)
            codeRally(c, winner: .home)
            if let t = c.state.tokens().first(where: { $0.side == .home && $0.position == .p4 }) { c.openSkillPad(for: t) }
            model.screen = .live(c)
        case "studio", "studio3d", "pov":
            var scene = SceneStore.newScene(labels: [.p1: "8", .p2: "12", .p3: "4", .p4: "9", .p5: "14", .p6: "2"])
            scene.title = "Tip coverage vs Dynamo R3"
            let c = StudioController(scene: scene)
            // Zones built from synthetic hand strokes through the real recognizer and snapping.
            let seam = CourtFrame.world(LocalPoint(l: 1.5, d: 4.5), of: .opponent)
            note("studio: scene ready")
            demoZone(c, loop(FloorPoint(x: seam.x + 0.1, z: seam.z - 0.1), 1.2), tag: .tipAlert)
            demoZone(c, box(FloorPoint(x: 1.6, z: 6.1), FloorPoint(x: 4.4, z: 8.8)), tag: .noFly)
            demoZone(c, loop(FloorPoint(x: -3.0, z: -7.4), 1.0, squash: 0.55), tag: .serveTarget)
            demoZone(c, loop(FloorPoint(x: 0.0, z: 4.6), 1.1, squash: 0.8), tag: .freeBall, forced: .freeform)
            note("studio: \(c.scene.zones.count) zones: " + c.scene.zones.map { "\($0.semantic.tag.rawValue) \($0.geometry)" }.joined(separator: " | "))
            c.tool = .zone
            if screen == "studio3d" || screen == "pov" {
                // Opponent front row up at the net, home passers low.
                for t in c.scene.tokens {
                    if t.side == .opponent && abs(t.point.z) < 3.5 {
                        c.selectToken(t.id)
                        c.setPosture(.blockReady)
                    } else if t.side == .home && ["OH1", "OH2", "L"].contains(t.role) {
                        c.selectToken(t.id)
                        c.setPosture(.pass)
                    }
                }
                c.selectToken(c.scene.tokens.first { $0.side == .home && $0.role == "S" }?.id)
                c.setPosture(.set)
            }
            demoTimeline(c)
            if screen == "studio3d" || screen == "pov" {
                // At the attack the opposing front row is in the air at block peak.
                c.scrub(to: 3)
                for t in c.scene.tokens where t.side == .opponent && abs(t.point.z) < 3.5 {
                    c.selectToken(t.id)
                    c.setPosture(.block)
                }
                c.selectToken(nil)
            }
            // Between SET and ATTACK: players on their way, the tip zone half-way from circle to rectangle.
            c.scrub(to: 2.2)
            note("timeline at 2.2: morphs \(c.frame.morphs.count), posture blends \(c.frame.postureBlends.count), "
                 + "keys " + c.scene.tokens.filter { $0.keys != nil }.map { "\($0.role):\($0.keys!.map(\.phase.rawValue))" }.joined(separator: " "))
            if screen == "studio3d" {
                c.tool = .select
                c.selectToken(c.scene.tokens.first { $0.side == .home && $0.role == "OH1" }?.id)
                c.toggle3D()
                c.toggleGaze()
                note("studio3d: postures " + c.frame.tokens.map { "\($0.label):\($0.posture?.rawValue ?? "-")" }.joined(separator: " "))
                note("studio3d gaze: " + c.gazeReadouts.map(\.text).joined(separator: " | "))
            } else if screen == "pov" {
                // The opposing middle blocker's eyes at the home attack.
                c.scrub(to: 3)
                c.tool = .select
                c.selectToken(c.scene.tokens.first { $0.side == .opponent && $0.role == "MB1" }?.id)
                c.toggle3D()
                c.enterPOV()
                note("pov gaze: " + c.gazeReadouts.map(\.text).joined(separator: " | "))
            } else {
                c.tool = .zone
            }
            model.screen = .studio(c)
        case "rally", "rallyeye":
            // One tap: the lineup plays a rally out (attack on the left); shown in 3D at the attack, the ball in the air.
            let c = StudioController(scene: SceneStore.newScene(labels: [.p1: "8", .p2: "12", .p3: "4", .p4: "9", .p5: "14", .p6: "2"]))
            c.playRally(.left)
            c.scrub(to: screen == "rally" ? 2.7 : 2.85)
            c.toggle3D()
            note("rally: " + c.ballPlan.segments.map { $0.summary(netHeight: c.netHeight) }.joined(separator: " | "))
            note("rally facing at 2.7: " + c.frame.tokens.map { "\($0.side == .home ? "" : "o")\($0.label):\(Int(($0.facing * 180 / .pi).rounded()))" }
                .joined(separator: " "))
            if screen == "rallyeye" {
                // The opposing middle blocker's eyes as the set goes up.
                c.selectToken(c.scene.tokens.first { $0.side == .opponent && $0.role == "MB1" }?.id)
                c.enterPOV()
            }
            model.screen = .studio(c)
        case "videomark":
            // Video to 3D, step 2: the dots near the corners of a hall seen from the stands, the court fitted over it.
            let importer = VideoImportModel()
            if let still = VideoDemo.still() { importer.demo(still: still, camera: VideoDemo.camera) }
            note("videomark: fit \(importer.fit) lines \(importer.courtLines.count)")
            model.screen = .videoImport(importer)
        case "videowatch", "video3d", "videoeye":
            // A rally filmed by a synthetic camera, rebuilt by the real pipeline: the clip with tappable players, the
            // 3D court in the hall from its plate, and a player's eye view with the clip in the corner.
            let start = Date()
            guard let saved = VideoDemo.saved() else { note("video: demo failed"); return }
            let (scene, folder) = saved
            note(String(format: "video: %d players, %d ball flights, %.1f s, clip %@, built in %.1f s", scene.players.count, scene.ball.count,
                        scene.duration, scene.videoFile ?? "none", Date().timeIntervalSince(start)))
            let w = VideoWatchController(scene: scene, folder: folder)
            w.seek(to: screen == "videoeye" ? 3.2 : 2.4)
            note("videowatch markers: " + w.markers.map { "\($0.label)" }.joined(separator: " "))
            if screen == "video3d" { w.mode = .court }
            if screen == "videoeye", let m = w.markers.first(where: { $0.side == .home && $0.label == "2" }) ?? w.markers.first {
                w.watch(m.id)
            }
            model.screen = .videoWatch(w)
        case "gallery":
            // Every technique of the posture library side by side, each in the variant of the position that uses it
            // most, seen side-on from the bench. Jersey numbers index the legend in the diagnostics.
            let roles: [Posture: String] = [.readyHigh: "S", .lowDefence: "L", .pass: "L", .angledPass: "OH2", .overheadPass: "L",
                                            .dig: "L", .sprawl: "L", .set: "S", .backSet: "S", .jumpSet: "S", .quickAttack: "MB1",
                                            .landing: "OPP", .blockReady: "MB1", .block: "MB1", .blockLanding: "MB2",
                                            .floatServe: "S", .jumpServe: "OPP", .cover: "OH2", .reach: "MB1"]
            let xs = [-3.4, -1.15, 1.15, 3.4], zs = [-7.5, -4.5, -1.5, 1.5, 4.5, 7.5]
            var tokens: [SceneToken] = []
            for (i, posture) in PostureStrip.order.enumerated() {
                let role = roles[posture] ?? "OH1"
                tokens.append(SceneToken(side: .home, label: "\(i + 1)", role: role,
                                         point: FloorPoint(x: xs[i % 4], z: zs[i / 4]), posture: posture))
            }
            let c = StudioController(scene: TacticalScene(title: "Technique gallery", tokens: tokens))
            c.tool = .select
            c.toggle3D()
            note("gallery: " + tokens.map { "\($0.label)=\($0.posture!.rawValue)/\($0.role)" }.joined(separator: " "))
            note("posture library: " + PostureLibrary.shared.positions.map { "\($0.key) \($0.value.techniques.count)" }.sorted().joined(separator: ", "))
            model.screen = .studio(c)
        case "setbreak":
            guard let c = try? LiveController(setup: setup) else { return }
            playSet(c)
            model.screen = .live(c)
        case "log":
            guard let c = try? LiveController(setup: setup) else { return }
            playSet(c)
            c.close()
            // Give the journal actor its group commit, then open the log of this match.
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 800_000_000)
                if let s = MatchArchive.list().first { model.screen = .matchLog(s) }
            }
        default:
            model.refreshArchive()
        }
    }

    @MainActor
    private static func play(_ c: LiveController, rallies: [Side], scout: Bool) {
        for (i, w) in rallies.enumerated() {
            if scout && i % 2 == 0 { scoutAttack(c, i) }
            c.swipe(winner: w)
        }
    }

    @MainActor
    private static func playSet(_ c: LiveController) {
        var i = 0
        while c.state.context == .live && i < 80 {
            if i % 3 == 0 { scoutAttack(c, i) }
            c.swipe(winner: i % 3 == 2 ? .opponent : .home)
            i += 1
        }
    }

    /// A rally through the real editing paths: the setter runs to the target at RECEIVE, the left-side hitter
    /// opens at SET and attacks at ATTACK, and the tip zone holds through SET, then turns into a deeper rectangle.
    @MainActor
    private static func demoTimeline(_ c: StudioController) {
        c.enableTimeline()
        c.tool = .select
        func drag(_ role: String, to p: FloorPoint, at phase: RallyPhase) {
            guard let t = c.scene.time(of: phase) else { return }
            c.scrub(to: t)
            guard let token = c.frame.tokens.first(where: { $0.side == .home && $0.role == role }) else { return }
            c.pan(.began, world: token.point, token: token.id)
            c.pan(.changed, world: p, token: nil)
            c.pan(.ended, world: p, token: nil)
        }
        drag("S", to: CourtFrame.world(LocalPoint(l: 6.0, d: 0.7), of: .home), at: .receive)
        drag("OH1", to: CourtFrame.world(LocalPoint(l: -0.3, d: 3.8), of: .home), at: .set)
        drag("OH1", to: CourtFrame.world(LocalPoint(l: 1.0, d: 0.6), of: .home), at: .attack)
        c.selectToken(c.scene.tokens.first { $0.side == .home && $0.role == "OH1" }?.id)
        c.setPosture(.attack)
        // The ball: the opposing server floats it, the libero passes, the setter sets high, OH1 attacks cross-court.
        func contact(_ side: Side, _ role: String, at phase: RallyPhase, _ kind: ContactKind) {
            guard let t = c.scene.time(of: phase) else { return }
            c.scrub(to: t)
            c.selectToken(c.scene.tokens.first { $0.side == side && $0.role == role }?.id)
            c.setContact(kind)
        }
        let server = c.scene.tokens.filter { $0.side == .opponent }.max { abs($0.point.z) < abs($1.point.z) }
        if let server { contact(.opponent, server.role, at: .serve, .floatServe) }
        contact(.home, "L", at: .receive, .pass)
        contact(.home, "S", at: .set, .highSet)
        contact(.home, "OH1", at: .attack, .attack)
        c.scrub(to: 3)
        c.aimLanding()
        c.tap(world: CourtFrame.world(LocalPoint(l: 7.5, d: 6.5), of: .opponent), token: nil)
        note("ball: " + c.ballPlan.segments.map { $0.summary(netHeight: c.netHeight) }.joined(separator: " | "))
        if let tip = c.scene.zones.first(where: { $0.semantic.tag == .tipAlert }) {
            c.scrub(to: 2)
            c.tap(world: tip.centroid, token: nil)
            c.pinSelection()
            c.scrub(to: 3)
            c.setShape(.rect)
            c.setShape(nil)
            if let shown = c.shownSelectedZone?.centroid {
                c.pan(.began, world: shown, token: nil)
                c.pan(.changed, world: FloorPoint(x: shown.x - 0.5, z: shown.z - 1.5), token: nil)
                c.pan(.ended, world: FloorPoint(x: shown.x - 0.5, z: shown.z - 1.5), token: nil)
            }
            note("tip zone keys: " + (c.scene.zones.first { $0.id == tip.id }?.keys ?? []).map { "\($0.phase.rawValue) \($0.geometry)" }.joined(separator: " | "))
        }
        c.selectToken(nil)
    }

    @MainActor
    private static func demoZone(_ c: StudioController, _ stroke: [FloorPoint], tag: ZoneTag, forced: ShapeKind? = nil) {
        c.setTag(tag)
        c.setShape(forced)
        c.tool = .zone
        c.boardSize = CGSize(width: 1100, height: 700)
        // Feed the stroke through the same path a finger takes.
        let g = c.geometry
        for (i, p) in stroke.enumerated() {
            c.pan(i == 0 ? .began : .changed, at: g.toView(p))
        }
        if let last = stroke.last { c.pan(.ended, at: g.toView(last)) }
        c.tap(at: .zero)                                   // deselect, so the next zone uses fresh defaults
    }

    private static func loop(_ c: FloorPoint, _ r: Double, squash: Double = 1) -> [FloorPoint] {
        (0..<90).map { i -> FloorPoint in
            let a = Double(i) / 89 * 2 * .pi * 1.04
            let rr = r * (1 + 0.02 * sin(3 * a + 1))
            return FloorPoint(x: c.x + rr * cos(a), z: c.z + rr * squash * sin(a))
        }
    }

    private static func box(_ lo: FloorPoint, _ hi: FloorPoint) -> [FloorPoint] {
        let corners = [lo, FloorPoint(x: hi.x, z: lo.z), hi, FloorPoint(x: lo.x, z: hi.z), lo]
        var out: [FloorPoint] = []
        for k in 0..<4 {
            let a = corners[k], b = corners[k + 1]
            for t in 0..<20 {
                let f = Double(t) / 20
                out.append(FloorPoint(x: a.x + (b.x - a.x) * f + 0.03 * sin(Double(t)), z: a.z + (b.z - a.z) * f))
            }
        }
        out.append(FloorPoint(x: lo.x + 0.05, z: lo.z + 0.1))
        return out
    }

    /// One coded rally: serve, reception, set and attack, then the swipe.
    @MainActor
    private static func codeRally(_ c: LiveController, winner: Side) {
        let receiving = c.state.match.current.serving.other
        let serving = c.state.match.current.serving
        func code(_ side: Side, _ pos: CourtPosition, _ skill: Skill, _ grade: SkillGrade) {
            guard let t = c.state.tokens().first(where: { $0.side == side && $0.position == pos }) else { return }
            c.openSkillPad(for: t)
            c.code(skill: skill, grade: grade)
        }
        code(serving, .p1, .serve, .fair)
        code(receiving, .p6, .reception, .positive)
        code(receiving, .p2, .set, .perfect)
        code(receiving, .p4, .attack, winner == receiving ? .perfect : .error)
        c.swipe(winner: winner)
    }

    /// Two scouting taps: origin in the opponent's front court, landing in the home half.
    @MainActor
    private static func scoutAttack(_ c: LiveController, _ i: Int) {
        let g = c.geometry
        guard g.size.width > 0 else {
            c.boardSize = CGSize(width: 1100, height: 700)
            return scoutAttack(c, i)
        }
        let origin = g.toView(LocalPoint(l: [1.0, 4.5, 8.0][i % 3], d: 1.0), side: .opponent)
        let landing = g.toView(LocalPoint(l: [7.5, 2.0, 4.5, 1.2][i % 4], d: [6.0, 3.5, 8.0, 2.0][i % 4]), side: .home)
        c.tap(at: origin)
        c.tap(at: landing)
    }

    /// Appends a line to Documents/demo-diagnostics.txt, which CI publishes next to the screenshots.
    static func note(_ line: String) {
        guard screen != nil,
              let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else { return }
        let url = dir.appendingPathComponent("demo-diagnostics.txt")
        let data = Data((line + "\n").utf8)
        if let h = try? FileHandle(forWritingTo: url) {
            _ = try? h.seekToEnd()
            try? h.write(contentsOf: data)
            try? h.close()
        } else {
            try? data.write(to: url)
        }
    }
}
