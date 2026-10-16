import Foundation

/// A player token in a tactical scene, in world metres.
public struct SceneToken: Codable, Hashable, Sendable, Identifiable {
    public var id: UUID
    public var side: Side
    public var label: String
    public var role: String
    public var point: FloorPoint
    /// 3D avatar posture; nil uses the default (ready on court, standing behind the end line).
    public var posture: Posture?
    /// Stature in metres for the 3D avatar; nil uses a default by role.
    public var stature: Double?
    /// Keyframes at later phase markers; `point` and `posture` are the first marker's (Section 3.3).
    public var keys: [TokenKey]?

    public init(id: UUID = UUID(), side: Side, label: String, role: String, point: FloorPoint,
                posture: Posture? = nil, stature: Double? = nil, keys: [TokenKey]? = nil) {
        self.id = id
        self.side = side
        self.label = label
        self.role = role
        self.point = point
        self.posture = posture
        self.stature = stature
        self.keys = keys
    }

    public var effectivePosture: Posture { posture ?? Self.automaticPosture(at: point) }

    /// Facing the net: home players face -Z, opponents +Z (radians from +Z toward +X).
    public var facing: Double { side == .home ? .pi : 0 }
}

/// A manual scene for the Analysis Canvas (Screen 8): tokens, zones and ink, all in world metres.
public struct TacticalScene: Codable, Hashable, Sendable, Identifiable {
    public var id: UUID
    public var title: String
    public var createdAt: Date
    public var modifiedAt: Date
    public var tokens: [SceneToken]
    public var zones: [Zone]
    public var ink: [InkStroke]
    /// Phase markers of the scene's timeline in order (Section 3.5.7); nil for a static scene.
    public var phases: [RallyPhase]?

    public init(id: UUID = UUID(), title: String, tokens: [SceneToken] = [], zones: [Zone] = [], ink: [InkStroke] = []) {
        self.id = id
        self.title = title
        self.createdAt = Date()
        self.modifiedAt = Date()
        self.tokens = tokens
        self.zones = zones
        self.ink = ink
    }

    /// A new scene with both teams standing in template formations (home receiving, opponent serving by default).
    public static func fromFormations(title: String, home: RotationTemplate, homeRotation: Int, homePhase: String,
                                      opponent: RotationTemplate, opponentRotation: Int,
                                      homeLabels: [CourtPosition: String] = [:]) -> TacticalScene {
        func tokens(_ t: RotationTemplate, rotation: Int, phase: String, side: Side, labels: [CourtPosition: String]) -> [SceneToken] {
            let formation = t.formation(rotation: rotation, phase: phase) ?? t.formations.first { $0.phase == phase } ?? t.formations.first
            let anchors = formation?.positions ?? LiveState.genericAnchors(serving: phase == "serve")
            return CourtPosition.allCases.compactMap { pos in
                guard let p = anchors[pos] else { return nil }
                let role = formation?.players.first { $0.position == pos.rawValue }?.role ?? pos.label
                return SceneToken(side: side, label: labels[pos] ?? role, role: role, point: CourtFrame.world(p, of: side))
            }
        }
        let opponentPhase = homePhase == "receive" ? "serve" : "receive"
        return TacticalScene(title: title,
                             tokens: tokens(home, rotation: homeRotation, phase: homePhase, side: .home, labels: homeLabels)
                                 + tokens(opponent, rotation: opponentRotation, phase: opponentPhase, side: .opponent, labels: [:]))
    }
}

/// Undoable editing of a scene: every edit pushes the previous scene, so undo and redo are exact.
public struct SceneEditor: Sendable {
    public private(set) var scene: TacticalScene
    private var undoStack: [TacticalScene] = []
    private var redoStack: [TacticalScene] = []
    public static let historyLimit = 200

    public init(scene: TacticalScene) { self.scene = scene }

    public var canUndo: Bool { !undoStack.isEmpty }
    public var canRedo: Bool { !redoStack.isEmpty }

    private mutating func edit(_ change: (inout TacticalScene) -> Void) {
        var next = scene
        change(&next)
        guard next != scene else { return }
        undoStack.append(scene)
        if undoStack.count > Self.historyLimit { undoStack.removeFirst() }
        redoStack.removeAll()
        next.modifiedAt = Date()
        scene = next
    }

    public mutating func undo() {
        guard let previous = undoStack.popLast() else { return }
        redoStack.append(scene)
        scene = previous
    }

    public mutating func redo() {
        guard let next = redoStack.popLast() else { return }
        undoStack.append(scene)
        scene = next
    }

    public mutating func addZone(_ zone: Zone) { edit { $0.zones.append(zone) } }

    public mutating func replaceZone(_ zone: Zone) {
        edit { s in if let i = s.zones.firstIndex(where: { $0.id == zone.id }) { s.zones[i] = zone } }
    }

    public mutating func deleteZone(_ id: UUID) { edit { $0.zones.removeAll { $0.id == id } } }

    public mutating func setStyle(_ style: ZoneStyle, zone id: UUID) {
        edit { s in if let i = s.zones.firstIndex(where: { $0.id == id }) { s.zones[i].style = style } }
    }

    public mutating func setTag(_ tag: ZoneTag, zone id: UUID) {
        edit { s in
            guard let i = s.zones.firstIndex(where: { $0.id == id }) else { return }
            let tint = s.zones[i].style.tint
            s.zones[i].semantic = ZoneSemantic(tag: tag)
            s.zones[i].style = tag.defaultStyle
            s.zones[i].style.tint = tint
        }
    }

    /// Moves a token or zone by a world offset. Drags call this once at the end, so one drag is one undo step.
    public mutating func move(token id: UUID, to point: FloorPoint) {
        edit { s in if let i = s.tokens.firstIndex(where: { $0.id == id }) { s.tokens[i].point = point } }
    }

    public mutating func move(zone id: UUID, by dx: Double, _ dz: Double) {
        edit { s in if let i = s.zones.firstIndex(where: { $0.id == id }) { s.zones[i] = s.zones[i].translated(by: dx, dz) } }
    }

    public mutating func setPosture(_ posture: Posture?, token id: UUID) {
        edit { s in if let i = s.tokens.firstIndex(where: { $0.id == id }) { s.tokens[i].posture = posture } }
    }

    // MARK: - Timeline (Section 3.5.7)

    /// Turns the timeline on with these markers, or off with nil (keyframes are kept and return with the markers).
    public mutating func setPhases(_ phases: [RallyPhase]?) { edit { $0.phases = phases } }

    /// True when `phase` is a later marker of the timeline, where edits write keyframes instead of base values.
    private func isKeyed(_ phase: RallyPhase?) -> Bool {
        guard let phase, let i = scene.timeline.firstIndex(of: phase) else { return false }
        return i > 0
    }

    /// Moves a token at a phase marker: the first marker (or a static scene) moves the base position,
    /// a later marker sets that marker's keyframe.
    public mutating func move(token id: UUID, to point: FloorPoint, phase: RallyPhase?) {
        guard isKeyed(phase), let phase else { return move(token: id, to: point) }
        edit { s in
            guard let i = s.tokens.firstIndex(where: { $0.id == id }) else { return }
            var keys = s.tokens[i].keys ?? []
            if let k = keys.firstIndex(where: { $0.phase == phase }) { keys[k].point = point } else {
                keys.append(TokenKey(phase: phase, point: point))
            }
            s.tokens[i].keys = keys
        }
    }

    public mutating func setPosture(_ posture: Posture?, token id: UUID, phase: RallyPhase?) {
        guard isKeyed(phase), let phase else { return setPosture(posture, token: id) }
        let t = scene.time(of: phase) ?? 0
        let shown = scene.frame(at: t).tokens.first { $0.id == id }?.point
        edit { s in
            guard let i = s.tokens.firstIndex(where: { $0.id == id }), let shown else { return }
            var keys = s.tokens[i].keys ?? []
            if let k = keys.firstIndex(where: { $0.phase == phase }) { keys[k].posture = posture } else {
                keys.append(TokenKey(phase: phase, point: shown, posture: posture))
            }
            s.tokens[i].keys = keys
        }
    }

    /// Sets a zone's geometry at a phase marker (base geometry at the first marker or in a static scene).
    public mutating func setGeometry(_ geometry: ZoneGeometry, zone id: UUID, phase: RallyPhase?) {
        edit { s in
            guard let i = s.zones.firstIndex(where: { $0.id == id }) else { return }
            guard let phase, let p = s.timeline.firstIndex(of: phase), p > 0 else {
                s.zones[i].geometry = geometry
                return
            }
            let shownIntensity = s.frame(at: Double(p)).intensities[id] ?? 1
            var keys = s.zones[i].keys ?? []
            if let k = keys.firstIndex(where: { $0.phase == phase }) { keys[k].geometry = geometry } else {
                keys.append(ZoneKey(phase: phase, geometry: geometry, intensity: shownIntensity))
            }
            s.zones[i].keys = keys
        }
    }

    /// Moves a zone at a phase marker by translating the geometry it shows there.
    public mutating func move(zone id: UUID, by dx: Double, _ dz: Double, phase: RallyPhase?) {
        guard isKeyed(phase), let phase else { return move(zone: id, by: dx, dz) }
        guard let shown = scene.frame(at: scene.time(of: phase) ?? 0).zones.first(where: { $0.id == id }) else { return }
        setGeometry(shown.translated(by: dx, dz).geometry, zone: id, phase: phase)
    }

    /// Style intensity of a zone at a later marker (0 hides it there).
    public mutating func setIntensity(_ intensity: Double, zone id: UUID, phase: RallyPhase) {
        guard isKeyed(phase), let p = scene.time(of: phase) else { return }
        let shown = scene.frame(at: p).zones.first { $0.id == id }?.geometry
        edit { s in
            guard let i = s.zones.firstIndex(where: { $0.id == id }), let shown else { return }
            var keys = s.zones[i].keys ?? []
            if let k = keys.firstIndex(where: { $0.phase == phase }) { keys[k].intensity = intensity } else {
                keys.append(ZoneKey(phase: phase, geometry: shown, intensity: intensity))
            }
            s.zones[i].keys = keys
        }
    }

    /// Removes a token's or zone's keyframe at a marker, so it interpolates through that marker again.
    public mutating func clearKey(_ id: UUID, phase: RallyPhase) {
        edit { s in
            if let i = s.tokens.firstIndex(where: { $0.id == id }) {
                s.tokens[i].keys?.removeAll { $0.phase == phase }
                if s.tokens[i].keys?.isEmpty == true { s.tokens[i].keys = nil }
            }
            if let i = s.zones.firstIndex(where: { $0.id == id }) {
                s.zones[i].keys?.removeAll { $0.phase == phase }
                if s.zones[i].keys?.isEmpty == true { s.zones[i].keys = nil }
            }
        }
    }

    public mutating func addInk(_ stroke: InkStroke) { edit { $0.ink.append(stroke) } }

    public mutating func clearInk() { edit { $0.ink.removeAll() } }

    public mutating func rename(_ title: String) { edit { $0.title = title } }

    /// The topmost zone under a point (the last drawn wins), for selection.
    public func zone(at p: FloorPoint, tolerance: Double = 0.15) -> Zone? {
        scene.zones.last { $0.distance(to: p) <= tolerance }
    }

    public func token(near p: FloorPoint, within r: Double = 0.6) -> SceneToken? {
        scene.tokens.map { ($0, hypot($0.point.x - p.x, $0.point.z - p.z)) }.filter { $0.1 <= r }.min { $0.1 < $1.1 }?.0
    }
}
