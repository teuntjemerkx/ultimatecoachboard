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
        if view3D {
            povPlayer = nil
            gazePlayer = nil
            exiting3D = true
        } else {
            view3D = true
        }
    }

    func finishExit3D() {
        exiting3D = false
        view3D = false
    }

    func resetCamera() {
        povPlayer = nil
        cameraResetCount += 1
    }

    // MARK: - POV and gaze (Sections 5.1, 5.6, 5.7)

    /// The player whose eyes the 3D camera uses; nil for the orbit camera.
    private(set) var povPlayer: UUID?
    /// Free-look offsets from head-forward, radians (clamped to the neck's range by the core).
    private(set) var povYaw = 0.0
    private(set) var povPitch = 0.0
    /// Whose gaze rays and field-of-view bands are shown (the POV player while in POV).
    private(set) var gazePlayer: UUID?
    /// Explicit gaze targets; nil uses the role defaults (opposing setter's head, front row's hitting shoulders).
    private var gazeTargets: [UUID: GazeReadout.Aim]?

    func enterPOV() {
        guard view3D, let id = selectedToken else { return }
        if povPlayer != id { gazeTargets = nil }
        povPlayer = id
        gazePlayer = id
        povYaw = 0
        povPitch = 0
    }

    func exitPOV() { povPlayer = nil }

    func toggleGaze() {
        if gazePlayer != nil && gazePlayer == selectedToken { gazePlayer = nil; return }
        guard let id = selectedToken else { return }
        if gazePlayer != id { gazeTargets = nil }
        gazePlayer = id
    }

    /// Free-look in POV: horizontal drag turns the head, vertical drag tilts it.
    func look(dx: Double, dy: Double) {
        guard povPlayer != nil else { return }
        povYaw = max(-70 * .pi / 180, min(70 * .pi / 180, povYaw - dx))
        povPitch = max(-50 * .pi / 180, min(60 * .pi / 180, povPitch + dy))
    }

    /// Tapping another player while the gaze is shown adds or removes them as a target.
    func toggleGazeTarget(_ id: UUID) {
        guard let viewer = gazePlayer, id != viewer else { return }
        var targets = gazeTargets ?? Dictionary(uniqueKeysWithValues: currentGazeTargets(frame.posedPlayers()))
        if targets[id] != nil { targets[id] = nil } else {
            let role = scene.tokens.first { $0.id == id }?.role ?? ""
            targets[id] = ["S", "S1", "S2"].contains(role) ? .head : .hittingShoulder
        }
        gazeTargets = targets
    }

    private func currentGazeTargets(_ players: [PosedPlayer]) -> [(UUID, GazeReadout.Aim)] {
        guard let id = gazePlayer, let viewer = players.first(where: { $0.id == id }) else { return [] }
        if let gazeTargets { return gazeTargets.map { ($0.key, $0.value) }.sorted { $0.0.uuidString < $1.0.uuidString } }
        return Gaze.defaultTargets(for: viewer, among: players)
    }

    /// Gaze readouts for the gaze player at the current frame (eye and forward are independent of the viewport).
    func gazeAnalysis(_ f: SceneFrame) -> (eye: V3, forward: V3, side: Side, readouts: [GazeReadout])? {
        guard let id = gazePlayer else { return nil }
        let players = f.posedPlayers()
        guard let viewer = players.first(where: { $0.id == id }) else { return nil }
        let yaw = povPlayer == id ? povYaw : 0, pitch = povPlayer == id ? povPitch : 0
        let pov = viewer.skeleton.povPose(viewer.joints, aspect: 1, yaw: yaw, pitch: pitch)
        let headForward = viewer.skeleton.povPose(viewer.joints, aspect: 1).forward
        let readouts = Gaze.readouts(viewer: viewer, pov: pov, targets: currentGazeTargets(players), players: players,
                                     netHeight: netHeight)
        return (pov.eye, headForward, viewer.token.side, readouts)
    }

    var gazeReadouts: [GazeReadout] { gazeAnalysis(frame)?.readouts ?? [] }

    /// Net height for POV and line of sight: 2.43 m (men); 2.24 m (women) is a setting to come.
    var netHeight = 2.43

    var selectedTokenValue: SceneToken? { selectedToken.flatMap { id in scene.tokens.first { $0.id == id } } }

    /// The posture set explicitly for the selected player at the current marker (nil = automatic or inherited).
    var selectedExplicitPosture: Posture? {
        guard let t = selectedTokenValue else { return nil }
        if let phase = editPhase, scene.timeline.firstIndex(of: phase) ?? 0 > 0 {
            return t.keys?.first { $0.phase == phase }?.posture
        }
        return t.posture
    }

    /// Sets the selected player's 3D posture at the current marker; nil returns to the automatic one.
    func setPosture(_ posture: Posture?) {
        guard let id = selectedToken else { return }
        editor.setPosture(posture, token: id, phase: editPhase)
        scheduleSave()
    }

    // MARK: - Timeline (Section 3.5.7)

    /// Timeline position in phase-index units; markers sit at whole numbers.
    private(set) var time: Double = 0
    private(set) var playing = false
    private var timeTask: Task<Void, Never>?
    /// Seconds per phase interval during playback.
    static let secondsPerPhase = 1.1

    /// The scene as shown at the current timeline position.
    var frame: SceneFrame { scene.frame(at: time) }

    /// The marker the board rests on, or nil between markers and in a static scene.
    var currentPhase: RallyPhase? {
        let line = scene.timeline
        let i = time.rounded()
        guard !line.isEmpty, abs(time - i) < 1e-6, Int(i) < line.count else { return nil }
        return line[Int(i)]
    }

    /// Edits go to the current marker (the base at the first marker or in a static scene).
    var editPhase: RallyPhase? { currentPhase }

    var shownSelectedZone: Zone? { selectedZone.flatMap { id in frame.zones.first { $0.id == id } } }

    func enableTimeline() {
        editor.setPhases(RallyPhase.allCases)
        stopTimeline()
        time = 0
        scheduleSave()
    }

    func disableTimeline() {
        stopTimeline()
        editor.setPhases(nil)
        time = 0
        scheduleSave()
    }

    /// Flies the board to a marker (critically damped within the interval, linear time over 0.45 s).
    func go(to phase: RallyPhase) {
        guard let target = scene.time(of: phase) else { return }
        tween(to: target, duration: 0.45 * max(1, abs(target - time)).squareRoot())
    }

    /// Jumps straight to a timeline position (demo and tests).
    func scrub(to t: Double) {
        stopTimeline()
        time = max(0, min(Double(max(scene.timeline.count - 1, 0)), t))
    }

    func togglePlay() {
        if playing { stopTimeline(); time = time.rounded(); return }
        let end = Double(max(scene.timeline.count - 1, 0))
        if time >= end - 1e-6 { time = 0 }
        playing = true
        tween(to: end, duration: (end - time) * Self.secondsPerPhase, playback: true)
    }

    private func stopTimeline() {
        timeTask?.cancel()
        timeTask = nil
        playing = false
    }

    private func tween(to target: Double, duration: Double, playback: Bool = false) {
        timeTask?.cancel()
        let start = time
        let begin = Date()
        timeTask = Task { [weak self] in
            while !Task.isCancelled {
                let f = duration > 0 ? min(1, Date().timeIntervalSince(begin) / duration) : 1
                self?.time = start + (target - start) * f
                if f >= 1 { break }
                try? await Task.sleep(nanoseconds: 8_000_000)
            }
            if !Task.isCancelled, playback { self?.playing = false }
        }
    }

    /// Pins the selected player or zone at the current marker as shown, so later edits start from here.
    func pinSelection() {
        guard let phase = editPhase else { return }
        if let id = selectedToken, let t = frame.tokens.first(where: { $0.id == id }) {
            editor.move(token: id, to: t.point, phase: phase)
        } else if let z = shownSelectedZone {
            editor.setGeometry(z.geometry, zone: z.id, phase: phase)
        }
        scheduleSave()
    }

    /// Removes the selected item's keyframe at the current marker.
    func clearSelectionKey() {
        guard let phase = editPhase, let id = selectedToken ?? selectedZone else { return }
        editor.clearKey(id, phase: phase)
        scheduleSave()
    }

    /// Hides or shows the selected zone at the current marker (keyframed intensity).
    func toggleSelectedZoneVisibility() {
        guard let phase = editPhase, let id = selectedZone, scene.timeline.firstIndex(of: phase) ?? 0 > 0 else { return }
        let shown = frame.intensities[id] ?? 1
        editor.setIntensity(shown > 0.5 ? 0 : 1, zone: id, phase: phase)
        scheduleSave()
    }

    /// Whether the selected item has a keyframe at the marker (for the strip's dots).
    func selectionHasKey(at phase: RallyPhase) -> Bool {
        if let id = selectedToken { return scene.tokens.first { $0.id == id }?.keys?.contains { $0.phase == phase } == true }
        if let id = selectedZone { return scene.zones.first { $0.id == id }?.keys?.contains { $0.phase == phase } == true }
        return false
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
        for t in frame.tokens {
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
        } else if let z = frame.zone(at: w) {
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
        tool != .select || token != nil || frame.zone(at: w) != nil
    }

    /// One step of a one-finger pan on the floor; `token` is the player under the finger when it began.
    func pan(_ phase: BoardMTKView.PanPhase, world w: FloorPoint, token: UUID?) {
        // Edits land on a phase marker; while the timeline plays, the board is read-only.
        if playing { return }
        switch phase {
        case .began:
            alternative = nil
            if tool == .select {
                if let token {
                    dragTarget = .token(token)
                    selectedToken = token
                    selectedZone = nil
                } else if let z = frame.zone(at: w) {
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
            if let t = frame.tokens.first(where: { $0.id == id }) {
                editor.move(token: id, to: FloorPoint(x: t.point.x + dragOffset.dx, z: t.point.z + dragOffset.dz), phase: editPhase)
            }
        case .zone(let id):
            editor.move(zone: id, by: dragOffset.dx, dragOffset.dz, phase: editPhase)
        }
        scheduleSave()
    }

    private func finishZoneStroke(_ stroke: [FloorPoint]) {
        guard stroke.count >= 6,
              let result = ZoneBuilder.build(stroke: stroke, forced: forcedShape, tag: defaultTag, style: defaultStyle,
                                             snapping: snapping, tokens: frame.tokens.map(\.point), otherZones: frame.zones)
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
                                             snapping: snapping, tokens: frame.tokens.map(\.point),
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
        guard let kind, let zone = shownSelectedZone else { return }
        // Re-fit the selected zone's outline as the chosen shape.
        let outline = zone.outline
        let pts = outline.map { P2($0.x, $0.z) }
        guard let g = ZoneBuilder.geometry(kind, stroke: pts, recognized: SmartGeometry.recognize(pts)) else { return }
        var z = zone
        z.geometry = g
        if snapping { z = ZoneSnapping.snap(z, tokens: frame.tokens.map(\.point), otherZones: frame.zones.filter { $0.id != zone.id }).0 }
        editor.setGeometry(z.geometry, zone: z.id, phase: editPhase)
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

    var boardScene: BoardScene { boardScene(frame) }

    private func boardScene(_ f: SceneFrame) -> BoardScene {
        var s = BoardScene()
        for t in f.tokens {
            var p = t.point
            if case .token(let id) = dragTarget, id == t.id { p = FloorPoint(x: p.x + dragOffset.dx, z: p.z + dragOffset.dz) }
            s.tokens.append(.init(id: t.id, side: t.side, point: p, label: t.label, isLibero: t.role == "L",
                                  isServer: false, selected: t.id == selectedToken))
        }
        s.zones = f.zones.map { z in
            if case .zone(let id) = dragTarget, id == z.id { return z.translated(by: dragOffset.dx, dragOffset.dz) }
            return z
        }
        s.zoneMorphs = f.morphs
        s.zoneIntensities = f.intensities
        s.selectedZone = selectedZone
        s.ink = scene.ink.map(\.points) + (liveStroke.count > 1 ? [liveStroke] : [])
        s.highlights = highlights
        return s
    }

    var scene3D: Scene3D {
        let f = frame
        let flat = boardScene(f)
        var s = Scene3D()
        s.players = f.tokens.map { t in
            let point = flat.tokens.first { $0.id == t.id }?.point ?? t.point
            return Scene3D.Player(id: t.id, side: t.side, point: point, label: t.label,
                                  posture: t.posture ?? SceneToken.automaticPosture(at: point), blend: f.postureBlends[t.id],
                                  facing: t.facing, stature: t.effectiveStature,
                                  isLibero: t.role == "L", selected: t.id == selectedToken)
        }
        s.zones = flat.zones
        s.zoneMorphs = flat.zoneMorphs
        s.zoneIntensities = flat.zoneIntensities
        s.selectedZone = flat.selectedZone
        s.netHeight = netHeight
        s.pov = povPlayer.map { Scene3D.POV(player: $0, yaw: povYaw, pitch: povPitch) }
        if let g = gazeAnalysis(f) {
            s.gaze = g.readouts.map { r in
                Scene3D.GazeRay(from: g.eye, to: r.point, occlusion: r.visibility.occlusionPoint,
                                visible: r.visibility.fraction >= 0.5, side: g.side)
            }
            s.field = Scene3D.FieldCones(eye: g.eye, forward: g.forward, side: g.side, field: VisualField())
        }
        s.ink = flat.ink
        s.highlights = flat.highlights
        return s
    }
}
