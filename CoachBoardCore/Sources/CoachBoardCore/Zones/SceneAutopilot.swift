import Foundation

/// The attack the autopilot plays when it plays out a rally.
public enum AttackOption: String, Codable, CaseIterable, Sendable, Hashable {
    case left, middle, right, back

    public var title: String {
        switch self {
        case .left: return "Left"
        case .middle: return "Middle"
        case .right: return "Right"
        case .back: return "Back row"
        }
    }

    /// Template routes that hit this attack, in order of preference.
    var routes: [String] {
        switch self {
        case .left: return ["left"]
        case .middle: return ["quick"]
        case .right: return ["right", "dball"]
        case .back: return ["pipe", "dball"]
        }
    }

    /// Where the attacker meets the ball, in the attacking team's frame (l from its left sideline, d from the net).
    func contactSpot(setter: LocalPoint) -> LocalPoint {
        switch self {
        case .left: return LocalPoint(l: 1.0, d: 1.0)
        case .middle: return LocalPoint(l: max(1.5, setter.l - 1.3), d: 0.9)
        case .right: return LocalPoint(l: 8.0, d: 1.0)
        case .back: return LocalPoint(l: 4.5, d: 3.4)
        }
    }
}

/// What the coach picks once: both systems, both rotations and who serves. Everything else is placed from it.
public struct SceneSetup: Codable, Hashable, Sendable {
    public var homeSystem: String
    public var homeRotation: Int
    public var opponentSystem: String
    public var opponentRotation: Int
    public var homeServes: Bool
    public var attack: AttackOption
    /// Labels the coach gave players, keyed "home.OH1", kept across rotations and libero swaps.
    public var labels: [String: String]

    public init(homeSystem: String = TeamSystem.fiveOneOutside.rawValue, homeRotation: Int = 1,
                opponentSystem: String = TeamSystem.fiveOneOutside.rawValue, opponentRotation: Int = 1,
                homeServes: Bool = false, attack: AttackOption = .left, labels: [String: String] = [:]) {
        self.homeSystem = homeSystem
        self.homeRotation = homeRotation
        self.opponentSystem = opponentSystem
        self.opponentRotation = opponentRotation
        self.homeServes = homeServes
        self.attack = attack
        self.labels = labels
    }

    public func system(_ side: Side) -> String { side == .home ? homeSystem : opponentSystem }
    public func rotation(_ side: Side) -> Int { side == .home ? homeRotation : opponentRotation }
    public func serves(_ side: Side) -> Bool { homeServes == (side == .home) }

    public mutating func setRotation(_ r: Int, for side: Side) {
        if side == .home { homeRotation = r } else { opponentRotation = r }
    }

    static func labelKey(_ side: Side, _ role: String) -> String { "\(side.rawValue).\(role)" }
}

/// One player of a team's formation, as the autopilot reads it from a template.
struct PlacedPlayer {
    var role: String
    var position: CourtPosition
    var point: LocalPoint
    var route: String?
    var passes: Bool
    var switchTo: LocalPoint?
}

extension RotationTemplate {
    /// Rotations the template has formations for.
    public var rotations: [Int] { Array(Set(formations.map(\.rotation))).sorted() }

    /// The rotation after a side-out: the setter moves from P1 to P6, so R1 becomes R6, then R5 (the app names a
    /// rotation by the setter's position). Rotations the template lacks are skipped.
    public func nextRotation(after r: Int) -> Int { step(r, by: -1) }

    public func previousRotation(before r: Int) -> Int { step(r, by: 1) }

    private func step(_ r: Int, by delta: Int) -> Int {
        let available = Set(rotations)
        guard available.count > 1, (1...6).contains(r) else { return r }
        var n = r
        for _ in 0..<6 {
            n = ((n - 1 + delta) % 6 + 6) % 6 + 1
            if available.contains(n) { return n }
        }
        return r
    }

    /// The team's players for a phase. Without a serve formation (4-2, youth W) the receive formation's players
    /// stand on generic serving anchors.
    func placement(rotation: Int, serving: Bool) -> [PlacedPlayer] {
        let phase = serving ? "serve" : "receive"
        if let f = formation(rotation: rotation, phase: phase) {
            return f.players.compactMap { p in
                p.courtPosition.map { PlacedPlayer(role: p.role, position: $0, point: p.point, route: p.route, passes: p.passes,
                                                   switchTo: p.switchTo.map(LocalPoint.init)) }
            }
        }
        let source = formation(rotation: rotation, phase: "receive") ?? formations.first { $0.phase == "receive" } ?? formations.first
        let anchors = LiveState.genericAnchors(serving: serving)
        guard let source else {
            return CourtPosition.allCases.map { PlacedPlayer(role: $0.label, position: $0, point: anchors[$0]!, route: nil, passes: true, switchTo: nil) }
        }
        return source.players.compactMap { p in
            guard let pos = p.courtPosition else { return nil }
            return PlacedPlayer(role: p.role, position: pos, point: serving ? anchors[pos]! : p.point, route: serving ? nil : p.route,
                                passes: p.passes, switchTo: nil)
        }
    }

    /// Where a player goes in base defence: the serve formation's switch for that role, else the slot of the court
    /// position (P4 left front ... P1 right back).
    func baseSpot(role: String, position: CourtPosition, rotation: Int) -> LocalPoint {
        let serve = formation(rotation: rotation, phase: "serve")
        let partners = Set(libero?.replaces ?? [])
        let match = serve?.players.first { $0.role == role }
            ?? serve?.players.first { p in role == "L" ? partners.contains(p.role) : (partners.contains(role) && p.role == "L") }
        if let s = match?.switchTo, s.count == 2 { return LocalPoint(s) }
        let slots = baseSlots ?? Self.defaultBaseSlots
        let key: String
        switch position {
        case .p4: key = "LF"
        case .p3: key = "MF"
        case .p2: key = "RF"
        case .p5: key = "LB"
        case .p6: key = "MBK"
        case .p1: key = "RB"
        }
        return LocalPoint(slots[key] ?? Self.defaultBaseSlots[key]!)
    }

    static let defaultBaseSlots: [String: [Double]] = ["LF": [1.0, 0.7], "MF": [4.5, 0.7], "RF": [8.0, 0.7],
                                                       "LB": [1.2, 6.3], "MBK": [4.5, 8.0], "RB": [7.8, 6.3]]
    static let defaultRouteTargets: [String: [Double]] = ["left": [-0.3, 3.8], "right": [9.3, 3.8], "quick": [4.6, 3.0],
                                                          "pipe": [4.5, 6.6], "dball": [7.8, 6.6], "target": [6.0, 0.7]]

    func routeTarget(_ route: String) -> LocalPoint? {
        (routeTargets[route] ?? Self.defaultRouteTargets[route]).map(LocalPoint.init)
    }

    var setterSpot: LocalPoint { setterTarget.count == 2 ? LocalPoint(setterTarget) : LocalPoint(l: 6.0, d: 0.7) }
}

extension TacticalScene {
    /// Places both teams from a setup: the serving team in its serve formation (server behind the end line), the
    /// receiving team in its receive formation. Players keep their identity and label by role; the libero comes
    /// and goes as the template says. Any rally on the timeline is cleared; zones and ink stay.
    public mutating func place(_ setup: SceneSetup) {
        var setup = setup
        for t in tokens { setup.labels[SceneSetup.labelKey(t.side, t.role)] = t.label }
        var placed: [SceneToken] = []
        for side in Side.allCases {
            let players = Self.template(setup.system(side))?.placement(rotation: setup.rotation(side), serving: setup.serves(side)) ?? []
            var pool = tokens.filter { $0.side == side }
            for p in players {
                var token: SceneToken
                if let i = pool.firstIndex(where: { $0.role == p.role }) {
                    token = pool.remove(at: i)
                } else {
                    token = SceneToken(side: side, label: setup.labels[SceneSetup.labelKey(side, p.role)] ?? Self.shortLabel(p.role),
                                       role: p.role, point: FloorPoint(x: 0, z: 0))
                }
                token.point = CourtFrame.world(p.point, of: side)
                token.posture = nil
                token.keys = nil
                token.yaw = nil
                placed.append(token)
            }
        }
        tokens = placed
        phases = nil
        contacts = nil
        ballLanding = nil
        ballLandingHeight = nil
        self.setup = setup
    }

    /// The next rotation for a side (after a side-out), placed.
    public mutating func rotate(_ side: Side, forward: Bool = true) {
        var s = setup ?? SceneSetup()
        guard let t = Self.template(s.system(side)) else { return }
        s.setRotation(forward ? t.nextRotation(after: s.rotation(side)) : t.previousRotation(before: s.rotation(side)), for: side)
        place(s)
    }

    /// A new scene with both teams placed from a setup.
    public static func placed(title: String, setup: SceneSetup) -> TacticalScene {
        var scene = TacticalScene(title: title)
        scene.place(setup)
        return scene
    }

    static func template(_ id: String) -> RotationTemplate? { try? TemplateLibrary.template(id: id) }

    /// "C (setter)" reads "C" on a token.
    static func shortLabel(_ role: String) -> String { role.split(separator: " ").first.map(String.init) ?? role }

    // MARK: - Autopilot

    /// Plays the rally out from the placed formations: serve, pass, set, the chosen attack, block and cover, the dig,
    /// and both teams moving between, with postures and the ball's contacts. Everything it writes is ordinary
    /// keyframes and contacts, so the coach can change any of it afterwards.
    public mutating func playOut(_ attack: AttackOption? = nil) {
        var setup = self.setup ?? SceneSetup()
        if let attack { setup.attack = attack }
        place(setup)
        let serving: Side = setup.homeServes ? .home : .opponent
        let receiving = serving.other
        guard let st = Self.template(setup.system(serving)), let rt = Self.template(setup.system(receiving)) else { return }
        let sPlayers = st.placement(rotation: setup.rotation(serving), serving: true)
        let rPlayers = rt.placement(rotation: setup.rotation(receiving), serving: false)
        func token(_ side: Side, _ role: String) -> Int? { tokens.firstIndex { $0.side == side && $0.role == role } }
        func world(_ p: LocalPoint, _ side: Side) -> FloorPoint { CourtFrame.world(p, of: side) }
        func key(_ i: Int, _ phase: RallyPhase, _ p: LocalPoint, _ posture: Posture) {
            let side = tokens[i].side
            var keys = tokens[i].keys ?? []
            keys.removeAll { $0.phase == phase }
            keys.append(TokenKey(phase: phase, point: world(p, side), posture: posture))
            tokens[i].keys = keys
        }
        func local(_ i: Int) -> LocalPoint { CourtFrame.local(tokens[i].point, for: tokens[i].side) }
        func mix(_ a: LocalPoint, _ b: LocalPoint, _ t: Double) -> LocalPoint {
            LocalPoint(l: a.l + (b.l - a.l) * t, d: a.d + (b.d - a.d) * t)
        }

        phases = RallyPhase.allCases
        var newContacts: [BallContact] = []

        // Receiving team: pass, set, attack, cover, then back to base.
        let setterTarget = rt.setterSpot
        let setter = rPlayers.first { $0.route == "target" }
            ?? rPlayers.first { $0.role.lowercased().contains("setter") }
            ?? rPlayers.min { $0.point.distance(to: setterTarget) < $1.point.distance(to: setterTarget) }
        let passers = rPlayers.filter { $0.passes && $0.role != setter?.role }
        let passer = passers.min { abs($0.point.l - 4.5) + 0.3 * abs($0.point.d - 5) < abs($1.point.l - 4.5) + 0.3 * abs($1.point.d - 5) }
            ?? rPlayers.first { $0.role != setter?.role }
        let attacker = setup.attack.routes.lazy.compactMap { r in rPlayers.first { $0.route == r } }.first
            ?? rPlayers.first { $0.route == "left" } ?? rPlayers.first { $0.route != nil && $0.route != "target" }
        let attackRoute = attacker?.route ?? "left"
        let effectiveAttack: AttackOption = attackRoute == "quick" ? .middle : attackRoute == "pipe" ? .back
            : attackRoute == "dball" ? .back : attackRoute == "right" ? .right : .left
        let spot = effectiveAttack == .back && attackRoute == "dball" ? LocalPoint(l: 7.0, d: 3.4) : effectiveAttack.contactSpot(setter: setterTarget)

        for p in rPlayers {
            guard let i = token(receiving, p.role) else { continue }
            let start = p.point
            let base = rt.baseSpot(role: p.role, position: p.position, rotation: setup.rotation(receiving))
            if p.role == setter?.role {
                key(i, .receive, setterTarget, .ready)
                key(i, .set, setterTarget, .set)
                key(i, .attack, LocalPoint(l: setterTarget.l, d: setterTarget.d + 0.6), .cover)
                key(i, .cover, LocalPoint(l: setterTarget.l, d: setterTarget.d + 0.9), .cover)
                key(i, .defence, base, .ready)
                continue
            }
            let isPasser = p.role == passer?.role
            let approach = p.route.flatMap { rt.routeTarget($0) }
            key(i, .receive, start, isPasser ? .pass : (p.passes ? .ready : .readyHigh))
            if p.role == attacker?.role {
                let runFrom = approach ?? LocalPoint(l: spot.l, d: spot.d + 3)
                key(i, .set, runFrom, .approach)
                key(i, .attack, spot, .attack)
                key(i, .cover, LocalPoint(l: spot.l, d: spot.d + 0.3), .landing)
            } else if let approach {
                // Decoys run their routes too; their approach stops short of the net.
                key(i, .set, approach, .approach)
                key(i, .attack, mix(approach, LocalPoint(l: approach.l, d: 1.2), 0.6), .readyHigh)
                key(i, .cover, coverSpot(around: spot, from: approach), .cover)
            } else {
                // Back-row players without a route cover the hitter.
                let cover = coverSpot(around: spot, from: start)
                key(i, .set, mix(start, cover, 0.5), .ready)
                key(i, .attack, cover, .cover)
                key(i, .cover, cover, .cover)
            }
            key(i, .defence, base, .ready)
        }

        // Serving team: serve, switch to base, block, defend, dig.
        let server = sPlayers.first { $0.position == .p1 }
        let blockLine = 9 - spot.l          // the attack spot seen from across the net
        let frontRow = sPlayers.filter { $0.position.isFrontRow }
        let backRow = sPlayers.filter { !$0.position.isFrontRow }
        func baseOf(_ p: PlacedPlayer) -> LocalPoint {
            p.switchTo ?? st.baseSpot(role: p.role, position: p.position, rotation: setup.rotation(serving))
        }
        let blockers: [PlacedPlayer] = {
            let byDistance = frontRow.sorted { abs(baseOf($0).l - blockLine) < abs(baseOf($1).l - blockLine) }
            return Array(byDistance.prefix(effectiveAttack == .back ? 1 : 2)).sorted { baseOf($0).l < baseOf($1).l }
        }()
        // The attack goes cross-court, deep: across the net it lands on the far side from where it was hit.
        let target = LocalPoint(l: min(7.6, max(1.4, spot.l)), d: effectiveAttack == .back ? 7.8 : 6.2)
        let digger = backRow.min { baseOf($0).distance(to: target) < baseOf($1).distance(to: target) }
        let sSetterTarget = st.setterSpot
        let sSetter = sPlayers.first { ["S", "S1"].contains($0.role) || $0.role.lowercased().contains("setter") }

        for p in sPlayers {
            guard let i = token(serving, p.role) else { continue }
            let base = baseOf(p)
            let isServer = p.role == server?.role
            if isServer { tokens[i].posture = .floatServe }
            key(i, .receive, base, p.position.isFrontRow ? .blockReady : .ready)
            if let b = blockers.firstIndex(where: { $0.role == p.role }) {
                // Two blockers close side by side on the hitter, in the order they come from.
                let l = min(8.6, max(0.4, blockLine + (blockers.count == 1 ? 0 : (b == 0 ? -0.45 : 0.45))))
                key(i, .set, LocalPoint(l: (base.l + l) / 2, d: 0.5), .blockReady)
                key(i, .attack, LocalPoint(l: l, d: 0.35), .block)
                key(i, .cover, LocalPoint(l: l, d: 0.45), .blockLanding)
                key(i, .defence, LocalPoint(l: l, d: 2.6), .ready)
            } else if p.position.isFrontRow {
                // The front-row player not blocking drops off the net for the tip.
                let off = LocalPoint(l: min(8, max(1, base.l)), d: 3.2)
                key(i, .set, LocalPoint(l: base.l, d: 1.0), .blockReady)
                key(i, .attack, off, .lowDefence)
                key(i, .cover, off, .lowDefence)
                key(i, .defence, LocalPoint(l: off.l, d: 3.5), .ready)
            } else if p.role == digger?.role {
                key(i, .set, base, .ready)
                key(i, .attack, mix(base, target, 0.7), .lowDefence)
                key(i, .cover, target, .dig)
                key(i, .defence, target, .ready)
            } else {
                key(i, .set, base, .ready)
                key(i, .attack, base, .lowDefence)
                key(i, .cover, base, .lowDefence)
                key(i, .defence, base, .ready)
            }
            if p.role == sSetter?.role && p.role != digger?.role {
                key(i, .defence, sSetterTarget, .set)
            }
        }

        if let s = server, let i = token(serving, s.role) { newContacts.append(BallContact(phase: .serve, player: tokens[i].id, kind: .floatServe)) }
        if let p = passer, let i = token(receiving, p.role) { newContacts.append(BallContact(phase: .receive, player: tokens[i].id, kind: .pass)) }
        if let s = setter, let i = token(receiving, s.role) {
            newContacts.append(BallContact(phase: .set, player: tokens[i].id, kind: effectiveAttack == .middle ? .quickSet : .highSet))
        }
        if let a = attacker, let i = token(receiving, a.role) { newContacts.append(BallContact(phase: .attack, player: tokens[i].id, kind: .attack)) }
        if let d = digger, let i = token(serving, d.role) { newContacts.append(BallContact(phase: .cover, player: tokens[i].id, kind: .dig)) }
        contacts = newContacts.isEmpty ? nil : newContacts
        // The dig rises into the hands of the serving team's setter at their target.
        ballLanding = world(LocalPoint(l: sSetterTarget.l, d: sSetterTarget.d + 0.15), serving)
        let setterToken = sSetter.flatMap { token(serving, $0.role) }
        ballLandingHeight = (setterToken.map { tokens[$0].effectiveStature } ?? 1.9) + 0.15
        self.setup = setup
        separateKeys()
    }

    /// Keeps teammates at least 0.6 m apart at every marker; whoever plays the ball there stays put.
    private mutating func separateKeys() {
        let gap = 0.6
        for phase in timeline.dropFirst() {
            let player = contacts?.first { $0.phase == phase }?.player
            for side in Side.allCases {
                let idx = tokens.indices.filter { tokens[$0].side == side && tokens[$0].keys?.contains { $0.phase == phase } == true }
                for _ in 0..<4 {
                    for (n, a) in idx.enumerated() {
                        for b in idx.dropFirst(n + 1) {
                            guard let ka = tokens[a].keys?.firstIndex(where: { $0.phase == phase }),
                                  let kb = tokens[b].keys?.firstIndex(where: { $0.phase == phase }) else { continue }
                            let pa = tokens[a].keys![ka].point, pb = tokens[b].keys![kb].point
                            let dx = pb.x - pa.x, dz = pb.z - pa.z, d = hypot(dx, dz)
                            guard d < gap else { continue }
                            let (ux, uz) = d > 1e-6 ? (dx / d, dz / d) : (1.0, 0.0)
                            let push = gap - d
                            let wa = tokens[a].id == player ? 0.0 : tokens[b].id == player ? 1.0 : 0.5
                            tokens[a].keys![ka].point = clampSide(FloorPoint(x: pa.x - ux * push * wa, z: pa.z - uz * push * wa), side)
                            tokens[b].keys![kb].point = clampSide(FloorPoint(x: pb.x + ux * push * (1 - wa), z: pb.z + uz * push * (1 - wa)), side)
                        }
                    }
                }
            }
        }
    }

    private func clampSide(_ p: FloorPoint, _ side: Side) -> FloorPoint {
        FloorPoint(x: min(6, max(-6, p.x)), z: side == .home ? min(11, max(0.2, p.z)) : max(-11, min(-0.2, p.z)))
    }

    /// A cover spot about 1.8 m behind the hitter, on the side the coverer comes from.
    private func coverSpot(around spot: LocalPoint, from p: LocalPoint) -> LocalPoint {
        let dl = p.l - spot.l, dd = max(0.6, p.d - spot.d)
        let n = max(1e-6, (dl * dl + dd * dd).squareRoot())
        return LocalPoint(l: min(8.8, max(0.2, spot.l + dl / n * 1.8)), d: max(1.6, spot.d + dd / n * 1.8))
    }
}

// MARK: - Automatic facing

extension TacticalScene {
    /// The frame as shown: players without an explicit facing turn toward the ball; a player about to play it
    /// faces where it goes next. Without a ball the receiving team faces the server, everyone else the net.
    public func liveFrame(at time: Double, plan: BallPlan? = nil) -> SceneFrame {
        var f = frame(at: time)
        let ball = plan?.position(at: time)
        let server = f.tokens.first { abs($0.point.z) > 9 }
        for i in f.tokens.indices where f.tokens[i].yaw == nil {
            let t = f.tokens[i]
            if let ball {
                f.tokens[i].yaw = Self.facing(t, toward: ball, plan: plan, time: time)
            } else if let server, server.side != t.side {
                f.tokens[i].yaw = Self.yaw(from: t.point, to: server.point) ?? t.facing
            }
        }
        return f
    }

    static func facing(_ t: SceneToken, toward ball: V3, plan: BallPlan?, time: Double) -> Double {
        let net = t.side == .home ? Double.pi : 0
        var target = ball.floor
        // The player playing the ball now faces where it goes next.
        if let seg = plan?.segment(at: time), seg.contact.player == t.id, let traj = seg.trajectory {
            let u = seg.endTime > seg.startTime ? (time - seg.startTime) / (seg.endTime - seg.startTime) : 1
            if u < 0.35 { target = traj.end.floor }
        }
        guard let yaw = yaw(from: t.point, to: target) else { return net }
        // Very close to the ball the direction is noisy: blend toward the net.
        let d = hypot(target.x - t.point.x, target.z - t.point.z)
        let w = min(1, max(0, (d - 0.15) / 0.6))
        return blendAngle(net, yaw, w)
    }

    static func yaw(from a: FloorPoint, to b: FloorPoint) -> Double? {
        let dx = b.x - a.x, dz = b.z - a.z
        guard dx * dx + dz * dz > 1e-6 else { return nil }
        return atan2(dx, dz)
    }

    /// From a toward b by w along the shortest arc.
    static func blendAngle(_ a: Double, _ b: Double, _ w: Double) -> Double {
        var d = (b - a).truncatingRemainder(dividingBy: 2 * .pi)
        if d > .pi { d -= 2 * .pi }
        if d < -.pi { d += 2 * .pi }
        return a + d * w
    }
}

// MARK: - Placement help

/// Drop help for dragging players: snap to the formation's spots and keep players from standing inside each other.
public enum PlacementAssist {
    public static let snapRadius = 0.35
    public static let minSeparation = 0.5

    /// Spots worth snapping to on a side: the setup's formation anchors, base defence slots, route starts and the
    /// setter's target, in world metres.
    public static func spots(for side: Side, setup: SceneSetup?) -> [FloorPoint] {
        let setup = setup ?? SceneSetup()
        guard let t = TacticalScene.template(setup.system(side)) else { return [] }
        var local: [LocalPoint] = []
        for f in t.formations where f.rotation == setup.rotation(side) { local += f.players.map(\.point) }
        local += (t.baseSlots ?? RotationTemplate.defaultBaseSlots).values.map(LocalPoint.init)
        local += t.routeTargets.values.map(LocalPoint.init)
        local.append(t.setterSpot)
        return local.map { CourtFrame.world($0, of: side) }
    }

    /// Where a dropped player ends up: on a nearby spot if one is within reach, then nudged out of other players.
    public static func adjust(_ p: FloorPoint, token id: UUID, side: Side, others: [SceneToken], spots: [FloorPoint]) -> (point: FloorPoint, snapped: FloorPoint?) {
        var out = p
        var snapped: FloorPoint?
        if let s = spots.min(by: { hypot($0.x - p.x, $0.z - p.z) < hypot($1.x - p.x, $1.z - p.z) }),
           hypot(s.x - p.x, s.z - p.z) <= snapRadius,
           !others.contains(where: { $0.id != id && hypot($0.point.x - s.x, $0.point.z - s.z) < minSeparation }) {
            out = s
            snapped = s
        }
        for _ in 0..<3 {
            for o in others where o.id != id {
                let dx = out.x - o.point.x, dz = out.z - o.point.z
                let d = hypot(dx, dz)
                guard d < minSeparation else { continue }
                let (ux, uz) = d > 1e-6 ? (dx / d, dz / d) : (side == .home ? (0.0, 1.0) : (0.0, -1.0))
                out = FloorPoint(x: o.point.x + ux * minSeparation, z: o.point.z + uz * minSeparation)
                snapped = nil
            }
        }
        return (out, snapped)
    }
}
