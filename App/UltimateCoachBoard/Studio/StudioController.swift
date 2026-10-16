import Foundation
import Observation
import CoreGraphics
import CoachBoardCore

/// Manual scenes on disk (Application Support/Scenes, one JSON file per scene).
enum SceneStore {
    static func directory() throws -> URL {
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let dir = base.appendingPathComponent("Scenes", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    static func list() -> [TacticalScene] {
        guard let dir = try? directory(),
              let files = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) else { return [] }
        return files.filter { $0.pathExtension == "json" }
            .compactMap { try? JSONDecoder().decode(TacticalScene.self, from: Data(contentsOf: $0)) }
            .sorted { $0.modifiedAt > $1.modifiedAt }
    }

    static func save(_ scene: TacticalScene) {
        guard let dir = try? directory(), let data = try? JSONEncoder().encode(scene) else { return }
        try? data.write(to: dir.appendingPathComponent("\(scene.id.uuidString).json"), options: .atomic)
    }

    static func delete(_ id: UUID) {
        guard let dir = try? directory() else { return }
        try? FileManager.default.removeItem(at: dir.appendingPathComponent("\(id.uuidString).json"))
    }

    /// A fresh scene: the home team in its template's R1 receive formation, the opponent serving.
    static func newScene(system: TeamSystem = .fiveOneOutside, rotation: Int = 1, phase: String = "receive",
                         labels: [CourtPosition: String] = [:]) -> TacticalScene {
        let home = (try? TemplateLibrary.template(id: system.templateID)) ?? (try? TemplateLibrary.shipped(TeamSystem.fiveOneOutside.rawValue))
        let opponent = try? TemplateLibrary.shipped(TeamSystem.fiveOneOutside.rawValue)
        guard let home, let opponent else { return TacticalScene(title: "New scene") }
        return TacticalScene.fromFormations(title: "\(system.displayName) R\(rotation) \(phase)", home: home, homeRotation: rotation,
                                            homePhase: phase, opponent: opponent, opponentRotation: 1, homeLabels: labels)
    }
}

/// The Analysis Canvas in 2D (Screen 8, manual scenes): select and move, pen, and the Zone tool with Smart Geometry,
/// court-aware snapping and the W3 strip.
@MainActor
@Observable
final class StudioController {
    enum Tool: String, CaseIterable { case select, pen, zone }

    private(set) var editor: SceneEditor
    var scene: TacticalScene { editor.scene }

    var tool: Tool = .zone
    var boardSize: CGSize = .zero
    var homeOnLeft = true
    var geometry: BoardGeometry { BoardGeometry(size: boardSize, homeOnLeft: homeOnLeft) }

    // W3 strip: edits the selected zone, or sets the defaults for the next stroke.
    var forcedShape: ShapeKind?
    var defaultTag: ZoneTag = .custom
    var defaultStyle = ZoneTag.custom.defaultStyle
    var snapping = true

    private(set) var selectedZone: UUID?
    private(set) var selectedToken: UUID?
    private(set) var liveStroke: [FloorPoint] = []
    private var dragTarget: DragTarget?
    private var dragStart: FloorPoint?
    private var dragOffset = (dx: 0.0, dz: 0.0)
    private enum DragTarget { case token(UUID), zone(UUID) }

    /// The one-tap alternative chip (4 s) after an uncertain recognition.
    struct Alternative: Equatable {
        var kind: ShapeKind
        var stroke: [FloorPoint]
        var zoneID: UUID
        var anchor: FloorPoint
    }
    private(set) var alternative: Alternative?
    private(set) var highlights: [BoardScene.Route] = []
    private var alternativeTask: Task<Void, Never>?
    private var highlightTask: Task<Void, Never>?
    private var saveTask: Task<Void, Never>?

    init(scene: TacticalScene) {
        editor = SceneEditor(scene: scene)
    }

    // MARK: - 2D / 3D

    /// The board shows the 3D view; leaving it first flies the camera back to the top-down view.
    private(set) var view3D = false
    private(set) var exiting3D = false
    /// Bumped to fly the 3D camera back to the bench view.
    private(set) var cameraResetCount = 0

    func toggle3D() {
        if view3D { exiting3D = true } else { view3D = true }
    }

    func finishExit3D() {
        exiting3D = false
        view3D = false
    }

    func resetCamera() { cameraResetCount += 1 }

    var selectedTokenValue: SceneToken? { selectedToken.flatMap { id in scene.tokens.first { $0.id == id } } }

    /// Sets the selected player's 3D posture; nil returns to the automatic one.
    func setPosture(_ posture: Posture?) {
        guard let id = selectedToken else { return }
        editor.setPosture(posture, token: id)
        scheduleSave()
    }

    func selectToken(_ id: UUID?) {
        selectedToken = id
        if id != nil { selectedZone = nil }
    }

    var selectedZoneValue: Zone? { selectedZone.flatMap { id in scene.zones.first { $0.id == id } } }

    /// The style the strip shows: the selected zone's, or the defaults.
    var stripStyle: ZoneStyle { selectedZoneValue?.style ?? defaultStyle }
    var stripTag: ZoneTag { selectedZoneValue?.semantic.tag ?? defaultTag }

    // MARK: - Gestures

    private func world(_ p: CGPoint) -> FloorPoint { geometry.toWorld(p) }

    private func tokenHit(_ p: CGPoint) -> SceneToken? {
        var best: (SceneToken, CGFloat)?
        for t in scene.tokens {
            let v = geometry.toView(t.point)
            let d = hypot(v.x - p.x, v.y - p.y)
            if d <= 40, d < (best?.1 ?? .infinity) { best = (t, d) }
        }
        return best?.0
    }

    func tap(at p: CGPoint) { tap(world: world(p), token: tokenHit(p)?.id) }

    /// A tap on the floor at `w`, or on a player (2D: the token under the finger; 3D: the avatar's body).
    func tap(world w: FloorPoint, token: UUID?) {
        alternative = nil
        if let token {
            selectedToken = token
            selectedZone = nil
        } else if let z = editor.zone(at: w) {
            selectedZone = z.id
            selectedToken = nil
        } else {
            selectedZone = nil
            selectedToken = nil
        }
    }

    func pan(_ phase: BoardMTKView.PanPhase, at p: CGPoint) {
        pan(phase, world: world(p), token: phase == .began ? tokenHit(p)?.id : nil)
    }

    /// Whether a one-finger pan starting here would move something (in 3D an empty select pan orbits instead).
    func panWouldEdit(world w: FloorPoint, token: UUID?) -> Bool {
        tool != .select || token != nil || editor.zone(at: w) != nil
    }

    /// One step of a one-finger pan on the floor; `token` is the player under the finger when it began.
    func pan(_ phase: BoardMTKView.PanPhase, world w: FloorPoint, token: UUID?) {
        switch phase {
        case .began:
            alternative = nil
            if tool == .select {
                if let token {
                    dragTarget = .token(token)
                    selectedToken = token
                    selectedZone = nil
                } else if let z = editor.zone(at: w) {
                    dragTarget = .zone(z.id)
                    selectedZone = z.id
                    selectedToken = nil
                }
                dragStart = w
                dragOffset = (0, 0)
            } else {
                liveStroke = [w]
            }
        case .changed:
            if tool == .select {
                guard let start = dragStart, dragTarget != nil else { return }
                dragOffset = (w.x - start.x, w.z - start.z)
            } else if let last = liveStroke.last, hypot(last.x - w.x, last.z - w.z) > 0.02 {
                liveStroke.append(w)
            }
        case .ended:
            if tool == .select {
                commitDrag()
            } else if tool == .pen {
                if liveStroke.count > 1 { editor.addInk(InkStroke(points: liveStroke)) }
                liveStroke = []
                scheduleSave()
            } else {
                finishZoneStroke(liveStroke)
                liveStroke = []
            }
        case .cancelled:
            dragTarget = nil
            dragOffset = (0, 0)
            liveStroke = []
        }
    }

    private func commitDrag() {
        defer { dragTarget = nil; dragStart = nil; dragOffset = (0, 0) }
        guard let target = dragTarget, abs(dragOffset.dx) + abs(dragOffset.dz) > 0.01 else { return }
        switch target {
        case .token(let id):
            if let t = scene.tokens.first(where: { $0.id == id }) {
                editor.move(token: id, to: FloorPoint(x: t.point.x + dragOffset.dx, z: t.point.z + dragOffset.dz))
            }
        case .zone(let id):
            editor.move(zone: id, by: dragOffset.dx, dragOffset.dz)
        }
        scheduleSave()
    }

    private func finishZoneStroke(_ stroke: [FloorPoint]) {
        guard stroke.count >= 6,
              let result = ZoneBuilder.build(stroke: stroke, forced: forcedShape, tag: defaultTag, style: defaultStyle,
                                             snapping: snapping, tokens: scene.tokens.map(\.point), otherZones: scene.zones)
        else { return }
        editor.addZone(result.zone)
        selectedZone = result.zone.id
        selectedToken = nil
        show(result.snapped)
        if let alt = result.alternative {
            alternative = Alternative(kind: alt, stroke: stroke, zoneID: result.zone.id, anchor: result.zone.centroid)
            alternativeTask?.cancel()
            alternativeTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: 4_000_000_000)
                if !Task.isCancelled { self?.alternative = nil }
            }
        }
        scheduleSave()
    }

    /// The alternative chip: rebuild the last stroke as the runner-up shape, keeping the zone's identity.
    func acceptAlternative() {
        guard let alt = alternative, let old = scene.zones.first(where: { $0.id == alt.zoneID }),
              let result = ZoneBuilder.build(stroke: alt.stroke, forced: alt.kind, tag: old.semantic.tag, style: old.style,
                                             snapping: snapping, tokens: scene.tokens.map(\.point),
                                             otherZones: scene.zones.filter { $0.id != old.id })
        else { return }
        var zone = result.zone
        zone.id = old.id
        editor.replaceZone(zone)
        show(result.snapped)
        alternative = nil
        scheduleSave()
    }

    private func show(_ snaps: [SnapTarget]) {
        highlights = snaps.flatMap { s -> [BoardScene.Route] in
            switch s {
            case let .line(a, b):
                return [BoardScene.Route(a: a, b: b, late: false)]
            case let .point(p):
                return [BoardScene.Route(a: FloorPoint(x: p.x - 0.2, z: p.z), b: FloorPoint(x: p.x + 0.2, z: p.z), late: false),
                        BoardScene.Route(a: FloorPoint(x: p.x, z: p.z - 0.2), b: FloorPoint(x: p.x, z: p.z + 0.2), late: false)]
            case let .cell(lo, hi):
                let c = [FloorPoint(x: lo.x, z: lo.z), FloorPoint(x: hi.x, z: lo.z), FloorPoint(x: hi.x, z: hi.z), FloorPoint(x: lo.x, z: hi.z)]
                return (0..<4).map { BoardScene.Route(a: c[$0], b: c[($0 + 1) % 4], late: false) }
            }
        }
        highlightTask?.cancel()
        highlightTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 700_000_000)
            if !Task.isCancelled { self?.highlights = [] }
        }
    }

    // MARK: - Strip actions (selected zone, or defaults)

    func setShape(_ kind: ShapeKind?) {
        forcedShape = kind
        guard let kind, let zone = selectedZoneValue else { return }
        // Re-fit the selected zone's outline as the chosen shape.
        let outline = zone.outline
        let pts = outline.map { P2($0.x, $0.z) }
        guard let g = ZoneBuilder.geometry(kind, stroke: pts, recognized: SmartGeometry.recognize(pts)) else { return }
        var z = zone
        z.geometry = g
        if snapping { z = ZoneSnapping.snap(z, tokens: scene.tokens.map(\.point), otherZones: scene.zones.filter { $0.id != zone.id }).0 }
        editor.replaceZone(z)
        scheduleSave()
    }

    func updateStyle(_ change: (inout ZoneStyle) -> Void) {
        if let zone = selectedZoneValue {
            var style = zone.style
            change(&style)
            editor.setStyle(style, zone: zone.id)
            scheduleSave()
        } else {
            change(&defaultStyle)
        }
    }

    func setTag(_ tag: ZoneTag) {
        if let zone = selectedZoneValue {
            editor.setTag(tag, zone: zone.id)
            scheduleSave()
        } else {
            let tint = defaultStyle.tint
            defaultTag = tag
            defaultStyle = tag.defaultStyle
            defaultStyle.tint = tint
        }
    }

    func deleteSelection() {
        guard let id = selectedZone else { return }
        editor.deleteZone(id)
        selectedZone = nil
        scheduleSave()
    }

    func undo() { editor.undo(); validateSelection(); scheduleSave() }
    func redo() { editor.redo(); validateSelection(); scheduleSave() }

    func clearInk() {
        editor.clearInk()
        scheduleSave()
    }

    func rename(_ title: String) {
        editor.rename(title)
        scheduleSave()
    }

    private func validateSelection() {
        if let id = selectedZone, !scene.zones.contains(where: { $0.id == id }) { selectedZone = nil }
    }

    func open(_ scene: TacticalScene) {
        save()
        editor = SceneEditor(scene: scene)
        selectedZone = nil
        selectedToken = nil
        alternative = nil
    }

    // MARK: - Persistence

    private func scheduleSave() {
        saveTask?.cancel()
        saveTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 500_000_000)
            if !Task.isCancelled { self?.save() }
        }
    }

    func save() { SceneStore.save(scene) }

    // MARK: - Board scene

    var boardScene: BoardScene {
        var s = BoardScene()
        for t in scene.tokens {
            var p = t.point
            if case .token(let id) = dragTarget, id == t.id { p = FloorPoint(x: p.x + dragOffset.dx, z: p.z + dragOffset.dz) }
            s.tokens.append(.init(id: t.id, side: t.side, point: p, label: t.label, isLibero: t.role == "L",
                                  isServer: false, selected: t.id == selectedToken))
        }
        s.zones = scene.zones.map { z in
            if case .zone(let id) = dragTarget, id == z.id { return z.translated(by: dragOffset.dx, dragOffset.dz) }
            return z
        }
        s.selectedZone = selectedZone
        s.ink = scene.ink.map(\.points) + (liveStroke.count > 1 ? [liveStroke] : [])
        s.highlights = highlights
        return s
    }

    /// Default stature by role when a token has none (metres): liberos shortest, middles tallest.
    static func defaultStature(role: String) -> Double {
        switch role {
        case "L": return 1.80
        case "S", "S1", "S2": return 1.90
        case "MB", "MB1", "MB2", "M", "M1", "M2": return 2.02
        default: return 1.95
        }
    }

    var scene3D: Scene3D {
        let flat = boardScene
        var s = Scene3D()
        s.players = scene.tokens.map { t in
            var moved = t
            if let shown = flat.tokens.first(where: { $0.id == t.id }) { moved.point = shown.point }
            return Scene3D.Player(id: t.id, side: t.side, point: moved.point, label: t.label, posture: moved.effectivePosture,
                                  facing: t.facing, stature: t.stature ?? Self.defaultStature(role: t.role),
                                  isLibero: t.role == "L", selected: t.id == selectedToken)
        }
        s.zones = flat.zones
        s.selectedZone = flat.selectedZone
        s.ink = flat.ink
        s.highlights = flat.highlights
        return s
    }
}
