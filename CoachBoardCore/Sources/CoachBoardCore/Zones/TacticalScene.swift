import Foundation

/// A player token in a tactical scene, in world metres.
public struct SceneToken: Codable, Hashable, Sendable, Identifiable {
    public var id: UUID
    public var side: Side
    public var label: String
    public var role: String
    public var point: FloorPoint

    public init(id: UUID = UUID(), side: Side, label: String, role: String, point: FloorPoint) {
        self.id = id
        self.side = side
        self.label = label
        self.role = role
        self.point = point
    }
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
