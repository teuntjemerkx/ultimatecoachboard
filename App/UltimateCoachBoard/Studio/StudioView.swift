import SwiftUI
import MetalKit
import CoachBoardCore

/// Screen 8: the Analysis Canvas for manual scenes. Simple shows the lineup bar (system, rotation, who serves, play
/// a rally), moving players and drawing; Advanced adds the zone tools, keyframes, postures, ball contacts and gaze.
struct StudioView: View {
    @Bindable var controller: StudioController
    var onExit: () -> Void
    @State private var showScenes = false
    @State private var renaming = false
    @State private var newTitle = ""

    private var advanced: Bool { ThemeStore.shared.advanced }

    var body: some View {
        HStack(spacing: 0) {
            toolRail
            VStack(spacing: 0) {
                topBar
                ZStack(alignment: .topLeading) {
                    if controller.view3D {
                        Studio3DBoardView(controller: controller)
                    } else {
                        StudioBoardView(controller: controller)
                            .overlay { AlternativeChip(controller: controller) }
                    }
                    if controller.tool == .zone || controller.selectedZone != nil {
                        Group {
                            if advanced { ZoneStrip(controller: controller) } else { SimpleZoneStrip(controller: controller) }
                        }
                        .padding(12)
                    }
                    if controller.view3D && controller.povPlayer != nil {
                        FieldRings().allowsHitTesting(false)
                    }
                    if controller.view3D && controller.gazePlayer != nil {
                        GazePanel(controller: controller)
                            .frame(maxWidth: .infinity, alignment: .topTrailing)
                            .padding(12)
                    }
                    VStack(spacing: 8) {
                        Spacer()
                        if controller.view3D && (controller.selectedTokenValue != nil || controller.povPlayer != nil) {
                            POVStrip(controller: controller)
                        }
                        if controller.video != nil {
                            VideoStrip(controller: controller)
                        } else {
                            editingStrips
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.bottom, 14)
                    .frame(maxWidth: .infinity)
                    if showHint {
                        Text(hint)
                            .font(.themed(15, .medium))
                            .foregroundStyle(Tokens.textSecondary.color)
                            .padding(.horizontal, 14).padding(.vertical, 8)
                            .background(Tokens.canvasRaised.withAlpha(0.9).color, in: Capsule())
                            .frame(maxWidth: .infinity)
                            .padding(.top, 14)
                            .allowsHitTesting(false)
                    }
                }
            }
        }
        .background(Tokens.canvasBase.color)
        .sheet(isPresented: $showScenes) { SceneListSheet(controller: controller) }
        .alert("Name this board", isPresented: $renaming) {
            TextField("Name", text: $newTitle)
            Button("Save") { controller.rename(newTitle) }
            Button("Cancel", role: .cancel) {}
        }
        .onDisappear { controller.save() }
    }

    /// The bottom strips of a hand-made scene: postures, ball, timeline and the lineup bar.
    @ViewBuilder private var editingStrips: some View {
        if advanced && controller.view3D && controller.selectedTokenValue != nil {
            PostureStrip(controller: controller)
        }
        if advanced && !controller.scene.timeline.isEmpty {
            BallStrip(controller: controller)
        }
        if !controller.scene.timeline.isEmpty || advanced {
            TimelineStrip(controller: controller)
        }
        if controller.povPlayer == nil {
            LineupBar(controller: controller)
        }
    }

    private var showHint: Bool {
        if controller.video != nil { return controller.selectedToken == nil && controller.povPlayer == nil }
        return controller.scene.timeline.isEmpty && controller.scene.zones.isEmpty && controller.scene.ink.isEmpty
            && controller.selectedToken == nil
    }

    private var hint: String {
        if controller.video != nil { return "Tap a player, then see what they see" }
        switch controller.tool {
        case .select: return "Drag a player to move them, or play a rally below"
        case .pen: return "Draw with one finger"
        case .zone: return "Draw a zone with one finger"
        }
    }

    private var topBar: some View {
        HStack(spacing: 12) {
            Button { newTitle = controller.scene.title; renaming = true } label: {
                HStack(spacing: 6) {
                    Text(controller.scene.title).font(.themed(17, .semibold)).lineLimit(1)
                    Image(systemName: "pencil").font(.themed(12, .semibold)).foregroundStyle(Tokens.textSecondary.color)
                }
            }
            .foregroundStyle(Tokens.text.color)
            .accessibilityLabel("Rename this board")
            if advanced {
                Text("\(controller.scene.zones.count) zone\(controller.scene.zones.count == 1 ? "" : "s")")
                    .font(.themed(13, .medium)).foregroundStyle(Tokens.textSecondary.color)
            }
            Spacer()
            if advanced && controller.video == nil {
                StudioChip("Snap", symbol: "scope", on: controller.snapping) { controller.snapping.toggle() }
                StudioChip("Swap ends", symbol: "arrow.left.arrow.right") { controller.homeOnLeft.toggle() }
            }
            if controller.view3D {
                StudioChip("Reset view", symbol: "camera.metering.center.weighted") { controller.resetCamera() }
            }
            viewSwitch
            if controller.video == nil {
                StudioChip("Boards", symbol: "square.stack") { showScenes = true }
            }
        }
        .foregroundStyle(Tokens.text.color)
        .padding(.horizontal, 16)
        .frame(height: Tokens.statusHeight + 8)
        .background(Tokens.canvasRaised.color)
        .overlay(alignment: .bottom) { Rectangle().fill(Tokens.hairline.color).frame(height: 1) }
    }

    /// 2D or 3D as one segmented control.
    private var viewSwitch: some View {
        HStack(spacing: 2) {
            segment("2D", on: !controller.view3D) { if controller.view3D { controller.toggle3D() } }
            segment("3D", on: controller.view3D) { if !controller.view3D { controller.toggle3D() } }
        }
        .padding(3)
        .background(Tokens.canvasBase.color, in: RoundedRectangle(cornerRadius: Tokens.radiusSmall + 3))
        .disabled(controller.exiting3D)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(controller.view3D ? "Showing 3D" : "Showing 2D")
    }

    private func segment(_ title: String, on: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(.themed(14, .bold))
                .frame(width: 52, height: 38)
                .background(on ? Tokens.accent.color : .clear, in: RoundedRectangle(cornerRadius: Tokens.radiusSmall))
                .foregroundStyle(on ? Tokens.onAccent.color : Tokens.text.color)
        }
        .buttonStyle(.plain)
    }

    private var toolRail: some View {
        VStack(spacing: 6) {
            if controller.video == nil { editingTools }
            Spacer()
            railButton("Home", "house", enabled: true) { controller.save(); onExit() }
        }
        .padding(.vertical, 12)
        .frame(width: Tokens.railWidth)
        .background(Tokens.canvasRaised.color)
        .overlay(alignment: .trailing) { Rectangle().fill(Tokens.hairline.color).frame(width: 1) }
    }

    @ViewBuilder private var editingTools: some View {
        toolButton(.select, "Move", "hand.point.up.left")
        toolButton(.pen, "Draw", "pencil.tip")
        toolButton(.zone, "Zone", "square.dashed")
        Divider().overlay(Tokens.hairline.color).padding(.horizontal, 10).padding(.vertical, 4)
        railButton("Undo", "arrow.uturn.backward", enabled: controller.editor.canUndo) { controller.undo() }
        railButton("Redo", "arrow.uturn.forward", enabled: controller.editor.canRedo) { controller.redo() }
        if controller.selectedZone != nil {
            railButton("Delete", "trash", enabled: true) { controller.deleteSelection() }
        }
        if !controller.scene.ink.isEmpty {
            railButton("Erase", "eraser", enabled: true) { controller.clearInk() }
        }
    }

    private func toolButton(_ tool: StudioController.Tool, _ title: String, _ symbol: String) -> some View {
        let on = controller.tool == tool
        return Button { controller.tool = tool } label: {
            VStack(spacing: 4) {
                Image(systemName: symbol).font(.themed(20, .semibold))
                Text(title).font(.themed(11, .semibold))
            }
            .frame(width: Tokens.targetLivePrimary, height: Tokens.targetLivePrimary)
            .background(on ? Tokens.accent.color : .clear, in: RoundedRectangle(cornerRadius: Tokens.cornerRadius))
        }
        .foregroundStyle(on ? Tokens.onAccent.color : Tokens.text.color)
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    private func railButton(_ title: String, _ symbol: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 4) {
                Image(systemName: symbol).font(.themed(18, .semibold))
                Text(title).font(.themed(11, .semibold))
            }
            .frame(width: Tokens.targetLivePrimary, height: 54)
        }
        .foregroundStyle(Tokens.text.color)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.35)
    }
}

/// W3: one strip, one level deep. It edits the selected zone, or sets the defaults for the next stroke (Advanced).
struct ZoneStrip: View {
    @Bindable var controller: StudioController

    private let shapes: [(String, ShapeKind?)] = [("Auto", nil), ("Rectangle", .rect), ("Circle", .circle), ("Ellipse", .ellipse),
                                                  ("Polygon", .polygon), ("Free", .freeform)]
    private let patterns: [(String, ZonePattern)] = [("Cross", .crossHatch), ("Lines", .diagonal), ("Dots", .dots),
                                                     ("Glow", .glowFill), ("Outline", .outline)]
    private let tags: [(String, ZoneTag)] = [("No-fly", .noFly), ("Serve target", .serveTarget), ("Tip alert", .tipAlert),
                                             ("Free ball", .freeBall), ("Responsibility", .responsibility), ("Custom", .custom)]

    var body: some View {
        let style = controller.stripStyle
        VStack(alignment: .leading, spacing: 6) {
            row("Shape") {
                ForEach(shapes.indices, id: \.self) { i in
                    StudioChip(shapes[i].0, on: controller.forcedShape == shapes[i].1) { controller.setShape(shapes[i].1) }
                }
            }
            row("Fill") {
                ForEach(patterns.indices, id: \.self) { i in
                    let pattern = patterns[i].1
                    StudioChip(patterns[i].0, on: style.pattern == pattern) { controller.updateStyle { $0.pattern = pattern } }
                }
            }
            row("Density") {
                Slider(value: Binding(get: { 0.75 - style.spacing }, set: { v in controller.updateStyle { $0.spacing = 0.75 - v } }),
                       in: 0.15...0.6)
                    .frame(width: 160)
                Text("Angle \(Int((style.angle * 180 / .pi).rounded()))\u{00B0}").font(.dataMono).frame(width: 96)
                Stepper("", onIncrement: { controller.updateStyle { $0.angle += .pi / 12 } },
                        onDecrement: { controller.updateStyle { $0.angle -= .pi / 12 } })
                    .labelsHidden()
            }
            row("Edge") {
                StudioChip("Solid", on: style.edge == .solid) { controller.updateStyle { $0.edge = .solid } }
                StudioChip("Dashed", on: style.edge == .dashed) { controller.updateStyle { $0.edge = .dashed } }
                Spacer().frame(width: 16)
                StudioChip("Ours", on: style.tint == .pink) { controller.updateStyle { $0.tint = .pink } }
                StudioChip("Theirs", on: style.tint == .cyan) { controller.updateStyle { $0.tint = .cyan } }
            }
            row("Tag") {
                ForEach(tags.indices, id: \.self) { i in
                    StudioChip(tags[i].0, on: controller.stripTag == tags[i].1) { controller.setTag(tags[i].1) }
                }
            }
            Text(controller.selectedZone == nil ? "Settings for the next zone you draw" : "Editing the selected zone")
                .font(.themed(12, .medium)).foregroundStyle(Tokens.textSecondary.color)
        }
        .studioPanel(emphasis: true)
        .frame(maxWidth: 760, alignment: .leading)
    }

    private func row<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        HStack(spacing: 6) {
            Text(title).font(.themed(12, .semibold))
                .foregroundStyle(Tokens.textSecondary.color)
                .frame(width: 64, alignment: .leading)
            ScrollView(.horizontal, showsIndicators: false) { HStack(spacing: 6) { content() } }
        }
    }
}

/// The one-tap alternative chip beside a freshly recognized zone (Section 3.5.3).
struct AlternativeChip: View {
    let controller: StudioController

    var body: some View {
        if let alt = controller.alternative {
            let p = controller.geometry.toView(alt.anchor)
            Button { controller.acceptAlternative() } label: {
                Text("\(alt.kind.rawValue.uppercased())?")
                    .font(.themed(12, .heavy))
                    .padding(.horizontal, 12).frame(height: 36)
                    .background(Tokens.text.color, in: Capsule())
                    .foregroundStyle(Tokens.canvasBase.color)
            }
            .position(x: p.x, y: max(p.y - 56, 24))
        }
    }
}

/// Scene list: open, start new from a formation, delete.
struct SceneListSheet: View {
    let controller: StudioController
    @Environment(\.dismiss) private var dismiss
    @State private var scenes: [TacticalScene] = []
    @State private var system: TeamSystem = .fiveOneOutside
    @State private var rotation = 1
    @State private var phase = "receive"

    var body: some View {
        NavigationStack {
            List {
                Section("New board") {
                    Picker("System", selection: $system) {
                        ForEach(TeamSystem.allCases, id: \.self) { Text($0.displayName).tag($0) }
                    }
                    Picker("Rotation", selection: $rotation) { ForEach(1...6, id: \.self) { Text("\($0)").tag($0) } }
                        .pickerStyle(.segmented)
                    Picker("We", selection: $phase) {
                        Text("Receive").tag("receive")
                        Text("Serve").tag("serve")
                    }
                    .pickerStyle(.segmented)
                    Button("Create board") {
                        controller.open(SceneStore.newScene(system: system, rotation: rotation, phase: phase))
                        controller.save()
                        dismiss()
                    }
                }
                Section("Saved boards") {
                    ForEach(scenes) { s in
                        Button {
                            controller.open(s)
                            dismiss()
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(s.title).font(.themed(15, .semibold))
                                Text(s.modifiedAt.formatted(date: .abbreviated, time: .shortened))
                                    .font(.system(size: 12)).foregroundStyle(Tokens.textSecondary.color)
                            }
                        }
                        .foregroundStyle(Tokens.text.color)
                    }
                    .onDelete { offsets in
                        for i in offsets where scenes[i].id != controller.scene.id { SceneStore.delete(scenes[i].id) }
                        scenes = SceneStore.list()
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Tokens.canvasBase.color)
            .navigationTitle("Boards")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .onAppear {
                controller.save()
                scenes = SceneStore.list()
            }
        }
    }
}

/// The Metal board wired to the Studio: taps select, one-finger pans draw or move, two/three-finger taps undo/redo.
struct StudioBoardView: UIViewRepresentable {
    let controller: StudioController

    final class Coordinator {
        var renderer: BoardRenderer?
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> BoardMTKView {
        let view = BoardMTKView(frame: .zero, device: MTLCreateSystemDefaultDevice())
        context.coordinator.renderer = BoardRenderer(view: view)
        let c = controller
        view.drawingEnabled = true
        view.onTap = { c.tap(at: $0) }
        view.onUndo = { c.undo() }
        view.onRedo = { c.redo() }
        view.onPanEvent = { phase, point in c.pan(phase, at: point) }
        view.onResize = { size in DispatchQueue.main.async { c.boardSize = size } }
        return view
    }

    func updateUIView(_ view: BoardMTKView, context: Context) {
        _ = Tokens.theme.id                    // a template change redraws the board
        guard let renderer = context.coordinator.renderer else { return }
        var geometry = controller.geometry
        geometry.size = view.bounds.size
        renderer.geometry = geometry
        renderer.scene = controller.boardScene
        renderer.requestRedraw()
    }
}

/// The 3D board wired to the Studio (Section 3.2): taps pick avatars by their body, one-finger pans draw and drag
/// on the floor through the touch ray, two fingers orbit and pinch. Entering flies down from the top-down view
/// with a dolly-zoom; leaving flies back up before the 2D board takes over.
struct Studio3DBoardView: UIViewRepresentable {
    let controller: StudioController

    final class Coordinator {
        var renderer: Board3DRenderer?
        var introduced = false
        var exiting = false
        var homeOnLeft = true
        var resetCount = 0
        var povPlayer: UUID?
        /// A one-finger pan that started on empty floor with the select tool orbits instead of editing.
        var orbiting = false
        var lastPan: CGPoint = .zero
        var lastFloor: FloorPoint?
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> BoardMTKView {
        let view = BoardMTKView(frame: .zero, device: MTLCreateSystemDefaultDevice())
        let coordinator = context.coordinator
        coordinator.renderer = Board3DRenderer(view: view)
        coordinator.homeOnLeft = controller.homeOnLeft
        coordinator.resetCount = controller.cameraResetCount
        let c = controller
        view.drawingEnabled = true
        view.orbitEnabled = true
        view.accessibilityLabel = "Volleyball court in 3D"
        view.onTap = { p in
            guard let r = coordinator.renderer else { return }
            if c.povPlayer != nil {
                // In POV a tap on another player adds or removes them as a gaze target.
                if let id = r.player(at: p) { c.toggleGazeTarget(id) }
                return
            }
            if let id = r.player(at: p) {
                c.tap(world: r.scene.players.first { $0.id == id }?.point ?? FloorPoint(x: 0, z: 0), token: id)
            } else if let w = r.floorPoint(at: p) {
                c.tap(world: w, token: nil)
            } else {
                c.selectToken(nil)
            }
        }
        view.onUndo = { c.undo() }
        view.onRedo = { c.redo() }
        view.onPanEvent = { phase, p in
            guard let r = coordinator.renderer else { return }
            if c.povPlayer != nil {
                // Free-look: drag to turn and tilt the head within the neck's range.
                if phase == .began { coordinator.lastPan = p }
                if phase == .changed {
                    c.look(dx: Double(p.x - coordinator.lastPan.x) * 0.004, dy: Double(p.y - coordinator.lastPan.y) * 0.004)
                    coordinator.lastPan = p
                }
                return
            }
            let w = r.floorPoint(at: p)
            switch phase {
            case .began:
                let token = r.player(at: p)
                guard let w, c.panWouldEdit(world: w, token: token) else {
                    coordinator.orbiting = true
                    coordinator.lastPan = p
                    return
                }
                coordinator.orbiting = false
                coordinator.lastFloor = w
                c.pan(.began, world: w, token: token)
            case .changed:
                if coordinator.orbiting {
                    let d = CGPoint(x: p.x - coordinator.lastPan.x, y: p.y - coordinator.lastPan.y)
                    coordinator.lastPan = p
                    Self.orbit(r, by: d)
                } else if let w {
                    coordinator.lastFloor = w
                    c.pan(.changed, world: w, token: nil)
                }
            case .ended, .cancelled:
                if !coordinator.orbiting, let last = w ?? coordinator.lastFloor { c.pan(phase, world: last, token: nil) }
                coordinator.orbiting = false
                coordinator.lastFloor = nil
            }
        }
        view.onOrbit = { d in
            if c.povPlayer != nil { c.look(dx: Double(d.x) * 0.004, dy: Double(d.y) * 0.004); return }
            if let r = coordinator.renderer { Self.orbit(r, by: d) }
        }
        view.onPinch = { s in
            guard let r = coordinator.renderer, c.povPlayer == nil else { return }
            r.setCamera(r.camera.orbited(dHeading: 0, dPitch: 0, zoom: Double(s)))
        }
        view.onResize = { size in
            guard size.width > 0, let r = coordinator.renderer else { return }
            let aspect = Double(size.width / size.height)
            if !coordinator.introduced {
                coordinator.introduced = true
                if c.povPlayer != nil {
                    // Opened straight into a POV: the orbit rests at the bench (or where the video was filmed), the camera
                    // flies into the player's eyes.
                    r.setCamera(c.videoBoardCamera ?? .bench(aspect: aspect, homeOnLeft: c.homeOnLeft, vertical: Self.upright(aspect)))
                    r.flyToPOV()
                } else {
                    r.setCamera(.topDown(aspect: aspect, homeOnLeft: c.homeOnLeft, vertical: Self.upright(aspect)))
                    r.animateCamera(to: c.videoBoardCamera ?? .bench(aspect: aspect, homeOnLeft: c.homeOnLeft, vertical: Self.upright(aspect)))
                }
            }
        }
        return view
    }

    /// Upright views stand the court upright, as the 2D board does (Settings > Court).
    static func upright(_ aspect: Double) -> Bool { ThemeStore.shared.courtOrientation == .auto && aspect < 1 / 1.1 }

    /// Horizontal drag turns around the court, vertical drag tilts (about 0.35 degree per point).
    static func orbit(_ r: Board3DRenderer, by d: CGPoint) {
        r.setCamera(r.camera.orbited(dHeading: -Double(d.x) * 0.006, dPitch: Double(d.y) * 0.005, zoom: 1))
    }

    func updateUIView(_ view: BoardMTKView, context: Context) {
        _ = Tokens.theme.id                    // a template change redraws the board
        let coordinator = context.coordinator
        guard let renderer = coordinator.renderer else { return }
        renderer.scene = controller.scene3D
        renderer.requestRedraw()
        let aspect = renderer.aspect
        let c = controller
        if controller.exiting3D && !coordinator.exiting {
            coordinator.exiting = true
            renderer.animateCamera(to: .topDown(aspect: aspect, homeOnLeft: controller.homeOnLeft, vertical: Self.upright(aspect)), duration: 0.8) {
                DispatchQueue.main.async { c.finishExit3D() }
            }
        } else if coordinator.homeOnLeft != controller.homeOnLeft || coordinator.resetCount != controller.cameraResetCount {
            coordinator.homeOnLeft = controller.homeOnLeft
            coordinator.resetCount = controller.cameraResetCount
            renderer.animateCamera(to: controller.videoBoardCamera
                                   ?? .bench(aspect: aspect, homeOnLeft: controller.homeOnLeft, vertical: Self.upright(aspect)))
        }
        if coordinator.povPlayer != controller.povPlayer {
            coordinator.povPlayer = controller.povPlayer
            if controller.povPlayer != nil { renderer.flyToPOV() } else { renderer.flyToOrbit() }
        }
    }
}

/// Posture chips for the selected player in 3D (Section 5.2's library), in rally order.
struct PostureStrip: View {
    let controller: StudioController

    static let order: [Posture] = [.standing, .readyHigh, .ready, .lowDefence, .pass, .angledPass, .overheadPass, .dig, .sprawl,
                                   .set, .backSet, .jumpSet, .approach, .armCock, .attack, .quickAttack, .landing,
                                   .blockReady, .block, .blockLanding, .floatServe, .jumpServe, .cover, .reach]

    var body: some View {
        if let token = controller.selectedTokenValue {
            HStack(spacing: 6) {
                Text("\(token.label) body").font(.themed(13, .semibold))
                    .foregroundStyle(Tokens.textSecondary.color)
                let explicit = controller.selectedExplicitPosture
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        StudioChip("Auto", on: explicit == nil) { controller.setPosture(nil) }
                        ForEach(Self.order, id: \.self) { p in
                            StudioChip(p.title.sentenceCased, on: explicit == p) { controller.setPosture(p) }
                        }
                    }
                }
                .frame(maxWidth: 760)
            }
            .padding(10)
            .background(Tokens.canvasRaised.withAlpha(0.96).color, in: RoundedRectangle(cornerRadius: Tokens.cornerRadius))
            .overlay(RoundedRectangle(cornerRadius: Tokens.cornerRadius).stroke(Tokens.accent.withAlpha(0.5).color))
        }
    }
}

/// The rally timeline (Section 3.5.7): play, the phase markers and (Advanced) the selected item's keyframe at the
/// marker. Edits made while resting on a later marker become keyframes there; the first marker holds the base scene.
struct TimelineStrip: View {
    let controller: StudioController
    private var advanced: Bool { ThemeStore.shared.advanced }

    var body: some View {
        HStack(spacing: 6) {
            if controller.scene.timeline.isEmpty {
                StudioChip("Animate by phase", symbol: "film") { controller.enableTimeline() }
                    .accessibilityHint("Adds the phases serve to defence; players and zones can then change per phase")
            } else {
                Button { controller.togglePlay() } label: {
                    Image(systemName: controller.playing ? "pause.fill" : "play.fill")
                        .font(.themed(18, .bold))
                        .frame(width: 56, height: 44)
                        .background(Tokens.accentActive.color, in: RoundedRectangle(cornerRadius: Tokens.radiusSmall))
                        .foregroundStyle(Tokens.onAccent.color)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(controller.playing ? "Pause" : "Play the rally")
                let shown = Int(controller.time.rounded())
                ForEach(Array(controller.scene.timeline.enumerated()), id: \.element) { i, phase in
                    let on = shown == i
                    Button { controller.go(to: phase) } label: {
                        VStack(spacing: 2) {
                            Text(phase.displayName).font(.themed(13, .bold))
                            if advanced {
                                Circle().frame(width: 5, height: 5)
                                    .opacity(controller.selectionHasKey(at: phase) ? 1 : 0)
                            }
                        }
                        .padding(.horizontal, 10).frame(minHeight: 44)
                        .background(on ? Tokens.accent.color : Tokens.canvasBase.color, in: RoundedRectangle(cornerRadius: Tokens.radiusSmall))
                        .foregroundStyle(on ? Tokens.onAccent.color : Tokens.text.color)
                    }
                    .buttonStyle(.plain)
                }
                if advanced, controller.selectedToken != nil || controller.selectedZone != nil, let phase = controller.currentPhase,
                   controller.scene.timeline.first != phase {
                    Divider().frame(height: 28).overlay(Tokens.hairline.color)
                    if controller.selectionHasKey(at: phase) {
                        StudioChip("Clear key") { controller.clearSelectionKey() }
                    } else {
                        StudioChip("Hold here") { controller.pinSelection() }
                    }
                    if let zone = controller.selectedZone {
                        let hidden = (controller.frame.intensities[zone] ?? 1) < 0.5
                        StudioChip(hidden ? "Show" : "Hide", on: hidden) { controller.toggleSelectedZoneVisibility() }
                    }
                }
                Divider().frame(height: 28).overlay(Tokens.hairline.color)
                if advanced {
                    StudioChip("Static") { controller.disableTimeline() }
                } else {
                    StudioChip("Clear rally", symbol: "xmark") { controller.backToLineup() }
                }
            }
        }
        .studioPanel()
    }
}

/// Eye view (Section 5.1): fly into the selected player's eyes and back; Advanced adds the sight lines.
struct POVStrip: View {
    let controller: StudioController
    private var advanced: Bool { ThemeStore.shared.advanced }

    var body: some View {
        HStack(spacing: 8) {
            if let pov = controller.povPlayer {
                let label = controller.scene.tokens.first { $0.id == pov }?.label ?? ""
                Text("Eye view of \(label)").font(.themed(13, .semibold))
                    .foregroundStyle(Tokens.textSecondary.color)
                StudioChip("Look ahead", on: controller.povYaw == 0 && controller.povPitch == 0) {
                    controller.look(dx: controller.povYaw, dy: -controller.povPitch)
                }
                if let other = controller.selectedTokenValue, other.id != pov {
                    StudioChip("Switch to \(other.label)", symbol: "eye") { controller.enterPOV() }
                }
                StudioChip("Leave eye view", symbol: "xmark", prominent: true) { controller.exitPOV() }
            } else if let token = controller.selectedTokenValue {
                StudioChip("See what \(token.label) sees", symbol: "eye", prominent: true) { controller.enterPOV() }
                    .accessibilityLabel("See through the eyes of \(token.label)")
                if advanced {
                    StudioChip("Sight lines", on: controller.gazePlayer == token.id) { controller.toggleGaze() }
                        .accessibilityLabel("Sight lines and field of view of \(token.label)")
                }
            }
        }
        .studioPanel(emphasis: true)
    }
}

/// Gaze readouts (Section 5.6): one line per target with its band and visibility.
struct GazePanel: View {
    let controller: StudioController

    var body: some View {
        let readouts = controller.gazeReadouts
        VStack(alignment: .leading, spacing: 6) {
            Text("What they can see").font(.themed(13, .semibold))
                .foregroundStyle(Tokens.textSecondary.color)
            if readouts.isEmpty {
                Text(controller.povPlayer != nil ? "Tap a player to check if they can be seen" : "No players to check")
                    .font(.themed(13, .medium)).foregroundStyle(Tokens.textSecondary.color)
            }
            ForEach(readouts, id: \.self) { r in
                HStack(spacing: 6) {
                    Circle().fill((r.visibility.fraction >= 0.5 ? Tokens.text : RGBA(hex: 0xFF3B1A)).color).frame(width: 8, height: 8)
                    Text(r.text).font(.themed(13, .medium)).foregroundStyle(Tokens.text.color)
                }
            }
            if controller.povPlayer != nil {
                Text("Shows where the head points, not the eyes. The rings mark sharp and side vision.")
                    .font(.themed(12, .medium)).foregroundStyle(Tokens.textSecondary.color)
                    .frame(maxWidth: 300, alignment: .leading)
            }
        }
        .padding(10)
        .background(Tokens.canvasRaised.withAlpha(0.92).color, in: RoundedRectangle(cornerRadius: Tokens.cornerRadius))
        .overlay(RoundedRectangle(cornerRadius: Tokens.cornerRadius).stroke(Tokens.hairline.color))
        .frame(maxWidth: 420, alignment: .trailing)
    }
}

/// In POV, thin rings mark the central field (+-30 degrees) and the foveal core (+-2.5 degrees) (Section 5.7).
/// With 90 degrees horizontal field of view, an angle theta from the centre sits at (width / 2) * tan(theta).
struct FieldRings: View {
    var body: some View {
        GeometryReader { g in
            let half = g.size.width / 2
            let central = half * tan(30 * .pi / 180), foveal = half * tan(2.5 * .pi / 180)
            ZStack {
                Circle().stroke(Tokens.accent.withAlpha(0.55).color, lineWidth: 1.5)
                    .frame(width: central * 2, height: central * 2)
                Circle().stroke(Tokens.text.withAlpha(0.7).color, lineWidth: 1)
                    .frame(width: foveal * 2, height: foveal * 2)
            }
            .position(x: g.size.width / 2, y: g.size.height / 2)
        }
    }
}

/// Ball contacts at the current marker (Section 5.4): who plays the ball and how; the physics flies it to the
/// next contact. The readout describes the flight in the air at the current moment (Advanced).
struct BallStrip: View {
    let controller: StudioController

    var body: some View {
        HStack(spacing: 6) {
            Text("Ball").font(.themed(13, .semibold))
                .foregroundStyle(Tokens.textSecondary.color)
            if let phase = controller.currentPhase, let selected = controller.selectedTokenValue {
                let contact = controller.currentContact
                if contact?.player == selected.id, let kind = contact?.kind {
                    ForEach(ContactKind.choices(at: phase), id: \.self) { k in
                        StudioChip(k.displayName, on: k == kind) { controller.setContact(k) }
                    }
                    StudioChip("No ball") { controller.removeContact() }
                    if controller.currentContactIsLast {
                        StudioChip(controller.aimingLanding ? "Tap the floor" : "Aim", symbol: "scope", on: controller.aimingLanding) {
                            controller.aimLanding()
                        }
                    }
                } else {
                    StudioChip(contact == nil ? "\(selected.label) plays it" : "\(selected.label) plays it instead") {
                        controller.setContact()
                    }
                }
            } else if controller.scene.contacts == nil {
                Text("Pick a player on a phase to give them the ball")
                    .font(.themed(13, .medium)).foregroundStyle(Tokens.textSecondary.color)
            }
            if let summary = controller.ballSummary {
                Text(summary).font(.dataMono).foregroundStyle(Tokens.text.color).lineLimit(1)
            }
        }
        .studioPanel()
    }
}

extension ContactKind {
    var displayName: String {
        switch self {
        case .floatServe: return "Float serve"
        case .jumpServe: return "Jump serve"
        case .pass: return "Pass"
        case .quickSet: return "Quick set"
        case .secondTempoSet: return "Second tempo"
        case .highSet: return "High set"
        case .attack: return "Attack"
        case .freeball: return "Free ball"
        case .dig: return "Dig"
        }
    }
}

extension String {
    /// "LOW DEFENCE" reads "Low defence".
    var sentenceCased: String { self.prefix(1).uppercased() + self.dropFirst().lowercased() }
}

/// Playback of a video scene: play and pause, the scrubber, slow motion.
struct VideoStrip: View {
    let controller: StudioController

    var body: some View {
        HStack(spacing: 12) {
            Button { controller.toggleVideoPlay() } label: {
                Image(systemName: controller.playing ? "pause.fill" : "play.fill")
                    .font(.themed(18, .bold))
                    .frame(width: 56, height: 44)
                    .background(Tokens.accentActive.color, in: RoundedRectangle(cornerRadius: Tokens.radiusSmall))
                    .foregroundStyle(Tokens.onAccent.color)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(controller.playing ? "Pause" : "Play")
            Slider(value: Binding(get: { controller.time }, set: { controller.scrubVideo(to: $0) }),
                   in: 0...max(controller.videoDuration, 0.1))
                .frame(minWidth: 260, maxWidth: 520)
                .accessibilityLabel("Time in the rally")
            Text(String(format: "%.1f / %.1f s", controller.time, controller.videoDuration))
                .font(.dataMono).foregroundStyle(Tokens.text.color)
                .frame(width: 120, alignment: .leading)
            StudioChip("Slow", symbol: "tortoise", on: controller.slowMotion) { controller.slowMotion.toggle() }
        }
        .studioPanel()
    }
}
