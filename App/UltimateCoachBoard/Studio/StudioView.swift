import SwiftUI
import MetalKit
import CoachBoardCore

/// Screen 8 in 2D: the Analysis Canvas for manual scenes, with the Zone & Hatching tools (Section 3.5, W3).
struct StudioView: View {
    @Bindable var controller: StudioController
    var onExit: () -> Void
    @State private var showScenes = false
    @State private var renaming = false
    @State private var newTitle = ""

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
                        ZoneStrip(controller: controller).padding(12)
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
                        if controller.view3D && controller.selectedTokenValue != nil {
                            PostureStrip(controller: controller)
                        }
                        if !controller.scene.timeline.isEmpty {
                            BallStrip(controller: controller)
                        }
                        TimelineStrip(controller: controller)
                    }
                    .padding(.bottom, 16)
                    .frame(maxWidth: .infinity)
                    if controller.scene.zones.isEmpty && controller.scene.ink.isEmpty {
                        VStack {
                            Spacer()
                            Text("Draw a zone or drag a player").font(.system(size: 15))
                                .foregroundStyle(Tokens.textSecondary.color)
                                .padding(.bottom, 84)
                        }
                        .frame(maxWidth: .infinity)
                        .allowsHitTesting(false)
                    }
                }
            }
        }
        .background(Tokens.canvasBase.color)
        .sheet(isPresented: $showScenes) { SceneListSheet(controller: controller) }
        .alert("Scene title", isPresented: $renaming) {
            TextField("Title", text: $newTitle)
            Button("Rename") { controller.rename(newTitle) }
            Button("Cancel", role: .cancel) {}
        }
        .onDisappear { controller.save() }
    }

    private var topBar: some View {
        HStack(spacing: 16) {
            Text("STUDIO").font(.sectionLabel).foregroundStyle(Tokens.accent.color)
            Button { newTitle = controller.scene.title; renaming = true } label: {
                Text(controller.scene.title).font(.system(size: 15, weight: .semibold))
            }
            .foregroundStyle(Tokens.white.color)
            Text("\(controller.scene.zones.count) zone\(controller.scene.zones.count == 1 ? "" : "s")")
                .font(.sectionLabel).foregroundStyle(Tokens.textSecondary.color)
            Spacer()
            Toggle("Snap", isOn: $controller.snapping).toggleStyle(.button).font(.sectionLabel)
            if controller.view3D {
                Button("BENCH VIEW") { controller.resetCamera() }.font(.sectionLabel)
            }
            Button(controller.view3D ? "2D" : "3D") { controller.toggle3D() }
                .font(.sectionLabel)
                .disabled(controller.exiting3D)
                .accessibilityLabel(controller.view3D ? "Back to the 2D board" : "Show the board in 3D")
            Button("SWITCH ENDS") { controller.homeOnLeft.toggle() }.font(.sectionLabel)
            Button("SCENES") { showScenes = true }.font(.sectionLabel)
        }
        .foregroundStyle(Tokens.white.color)
        .padding(.horizontal, 16)
        .frame(height: Tokens.statusHeight + 8)
        .background(Tokens.canvasRaised.color)
        .overlay(alignment: .bottom) { Rectangle().fill(Tokens.hairline.color).frame(height: 1) }
    }

    private var toolRail: some View {
        VStack(spacing: 8) {
            toolButton(.select, "SELECT", "hand.point.up.left")
            toolButton(.pen, "PEN", "pencil.tip")
            toolButton(.zone, "ZONE", "square.dashed")
            Divider().overlay(Tokens.hairline.color).padding(.horizontal, 10)
            railButton("UNDO", "arrow.uturn.backward", enabled: controller.editor.canUndo) { controller.undo() }
            railButton("REDO", "arrow.uturn.forward", enabled: controller.editor.canRedo) { controller.redo() }
            railButton("DELETE", "trash", enabled: controller.selectedZone != nil) { controller.deleteSelection() }
            railButton("CLEAR INK", "eraser", enabled: !controller.scene.ink.isEmpty) { controller.clearInk() }
            Spacer()
            railButton("EXIT", "xmark", enabled: true) { controller.save(); onExit() }
        }
        .padding(.vertical, 12)
        .frame(width: Tokens.railWidth)
        .background(Tokens.canvasRaised.color)
        .overlay(alignment: .trailing) { Rectangle().fill(Tokens.hairline.color).frame(width: 1) }
    }

    private func toolButton(_ tool: StudioController.Tool, _ title: String, _ symbol: String) -> some View {
        let on = controller.tool == tool
        return Button { controller.tool = tool } label: {
            VStack(spacing: 4) {
                Image(systemName: symbol).font(.system(size: 20, weight: .semibold))
                Text(title).font(.system(size: 9, weight: .semibold).width(.expanded))
            }
            .frame(width: Tokens.targetLivePrimary, height: Tokens.targetLivePrimary)
            .background(on ? Tokens.accent.withAlpha(0.2).color : .clear, in: RoundedRectangle(cornerRadius: 6))
        }
        .foregroundStyle(on ? Tokens.accent.color : Tokens.white.color)
    }

    private func railButton(_ title: String, _ symbol: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 4) {
                Image(systemName: symbol).font(.system(size: 18, weight: .semibold))
                Text(title).font(.system(size: 9, weight: .semibold).width(.expanded))
            }
            .frame(width: Tokens.targetLivePrimary, height: 52)
        }
        .foregroundStyle(Tokens.white.color)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.35)
    }
}

/// W3: one strip, one level deep. It edits the selected zone, or sets the defaults for the next stroke.
struct ZoneStrip: View {
    @Bindable var controller: StudioController

    private let shapes: [(String, ShapeKind?)] = [("AUTO", nil), ("RECT", .rect), ("CIRCLE", .circle), ("ELLIPSE", .ellipse),
                                                  ("POLY", .polygon), ("FREE", .freeform)]
    private let patterns: [(String, ZonePattern)] = [("CROSS", .crossHatch), ("DIAG", .diagonal), ("DOTS", .dots),
                                                     ("GLOW", .glowFill), ("OUTLINE", .outline)]
    private let tags: [(String, ZoneTag)] = [("NO-FLY", .noFly), ("SERVE TGT", .serveTarget), ("TIP ALERT", .tipAlert),
                                             ("FREE BALL", .freeBall), ("RESPONSIBILITY", .responsibility), ("CUSTOM", .custom)]

    var body: some View {
        let style = controller.stripStyle
        VStack(alignment: .leading, spacing: 8) {
            row("SHAPE") {
                ForEach(shapes.indices, id: \.self) { i in
                    chip(shapes[i].0, on: controller.forcedShape == shapes[i].1) { controller.setShape(shapes[i].1) }
                }
            }
            row("FILL") {
                ForEach(patterns.indices, id: \.self) { i in
                    let pattern = patterns[i].1
                    chip(patterns[i].0, on: style.pattern == pattern) { controller.updateStyle { $0.pattern = pattern } }
                }
            }
            row("DENSITY") {
                Slider(value: Binding(get: { 0.75 - style.spacing }, set: { v in controller.updateStyle { $0.spacing = 0.75 - v } }),
                       in: 0.15...0.6)
                    .frame(width: 160)
                Text("ANGLE \(Int((style.angle * 180 / .pi).rounded()))\u{00B0}").font(.dataMono).frame(width: 96)
                Stepper("", onIncrement: { controller.updateStyle { $0.angle += .pi / 12 } },
                        onDecrement: { controller.updateStyle { $0.angle -= .pi / 12 } })
                    .labelsHidden()
            }
            row("EDGE") {
                chip("SOLID", on: style.edge == .solid) { controller.updateStyle { $0.edge = .solid } }
                chip("DASHED", on: style.edge == .dashed) { controller.updateStyle { $0.edge = .dashed } }
                Spacer().frame(width: 16)
                chip("PINK", on: style.tint == .pink) { controller.updateStyle { $0.tint = .pink } }
                chip("CYAN", on: style.tint == .cyan) { controller.updateStyle { $0.tint = .cyan } }
            }
            row("TAG") {
                ForEach(tags.indices, id: \.self) { i in
                    chip(tags[i].0, on: controller.stripTag == tags[i].1) { controller.setTag(tags[i].1) }
                }
            }
            Text(controller.selectedZone == nil ? "Defaults for the next stroke" : "Editing the selected zone")
                .font(.system(size: 11)).foregroundStyle(Tokens.textSecondary.color)
        }
        .padding(12)
        .background(Tokens.canvasRaised.withAlpha(0.96).color, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Tokens.accent.withAlpha(0.5).color))
        .frame(maxWidth: 660, alignment: .leading)
    }

    private func row<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        HStack(spacing: 6) {
            Text(title).font(.system(size: 10, weight: .semibold).width(.expanded))
                .foregroundStyle(Tokens.textSecondary.color)
                .frame(width: 64, alignment: .leading)
            content()
        }
    }

    private func chip(_ title: String, on: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(.system(size: 11, weight: .bold).width(.expanded))
                .padding(.horizontal, 8).frame(minHeight: 32)
                .background(on ? Tokens.accent.color : Tokens.canvasBase.color, in: RoundedRectangle(cornerRadius: 4))
                .foregroundStyle(on ? Tokens.canvasBase.color : Tokens.white.color)
        }
        .buttonStyle(.plain)
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
                    .font(.system(size: 12, weight: .heavy).width(.expanded))
                    .padding(.horizontal, 12).frame(height: 36)
                    .background(Tokens.white.color, in: Capsule())
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
                Section("New scene from a formation") {
                    Picker("System", selection: $system) {
                        ForEach(TeamSystem.allCases, id: \.self) { Text($0.displayName).tag($0) }
                    }
                    Picker("Rotation", selection: $rotation) { ForEach(1...6, id: \.self) { Text("R\($0)").tag($0) } }
                        .pickerStyle(.segmented)
                    Picker("Phase", selection: $phase) {
                        Text("Receive").tag("receive")
                        Text("Serve").tag("serve")
                    }
                    .pickerStyle(.segmented)
                    Button("Create") {
                        controller.open(SceneStore.newScene(system: system, rotation: rotation, phase: phase))
                        controller.save()
                        dismiss()
                    }
                }
                Section("Saved scenes") {
                    ForEach(scenes) { s in
                        Button {
                            controller.open(s)
                            dismiss()
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(s.title).font(.system(size: 15, weight: .semibold))
                                Text("\(s.zones.count) zones \u{00B7} \(s.modifiedAt.formatted(date: .abbreviated, time: .shortened))")
                                    .font(.system(size: 12)).foregroundStyle(Tokens.textSecondary.color)
                            }
                        }
                        .foregroundStyle(Tokens.white.color)
                    }
                    .onDelete { offsets in
                        for i in offsets where scenes[i].id != controller.scene.id { SceneStore.delete(scenes[i].id) }
                        scenes = SceneStore.list()
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Tokens.canvasBase.color)
            .navigationTitle("Scenes")
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
                r.setCamera(.topDown(aspect: aspect, homeOnLeft: c.homeOnLeft))
                r.animateCamera(to: .bench(aspect: aspect, homeOnLeft: c.homeOnLeft))
            }
        }
        return view
    }

    /// Horizontal drag turns around the court, vertical drag tilts (about 0.35 degree per point).
    static func orbit(_ r: Board3DRenderer, by d: CGPoint) {
        r.setCamera(r.camera.orbited(dHeading: -Double(d.x) * 0.006, dPitch: Double(d.y) * 0.005, zoom: 1))
    }

    func updateUIView(_ view: BoardMTKView, context: Context) {
        let coordinator = context.coordinator
        guard let renderer = coordinator.renderer else { return }
        renderer.scene = controller.scene3D
        renderer.requestRedraw()
        let aspect = renderer.aspect
        let c = controller
        if controller.exiting3D && !coordinator.exiting {
            coordinator.exiting = true
            renderer.animateCamera(to: .topDown(aspect: aspect, homeOnLeft: controller.homeOnLeft), duration: 0.8) {
                DispatchQueue.main.async { c.finishExit3D() }
            }
        } else if coordinator.homeOnLeft != controller.homeOnLeft || coordinator.resetCount != controller.cameraResetCount {
            coordinator.homeOnLeft = controller.homeOnLeft
            coordinator.resetCount = controller.cameraResetCount
            renderer.animateCamera(to: .bench(aspect: aspect, homeOnLeft: controller.homeOnLeft))
        }
        if coordinator.povPlayer != controller.povPlayer {
            coordinator.povPlayer = controller.povPlayer
            if controller.povPlayer != nil { renderer.flyToPOV() } else { renderer.flyToOrbit() }
        }
    }
}

/// Posture chips for the selected player in 3D (Section 5.2's library).
struct PostureStrip: View {
    let controller: StudioController

    var body: some View {
        if let token = controller.selectedTokenValue {
            HStack(spacing: 6) {
                Text("#\(token.label) POSTURE").font(.system(size: 10, weight: .semibold).width(.expanded))
                    .foregroundStyle(Tokens.textSecondary.color)
                let explicit = controller.selectedExplicitPosture
                chip("AUTO", on: explicit == nil) { controller.setPosture(nil) }
                ForEach(Posture.allCases, id: \.self) { p in
                    chip(p.rawValue.uppercased(), on: explicit == p) { controller.setPosture(p) }
                }
            }
            .padding(10)
            .background(Tokens.canvasRaised.withAlpha(0.96).color, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Tokens.accent.withAlpha(0.5).color))
        }
    }

    private func chip(_ title: String, on: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(.system(size: 11, weight: .bold).width(.expanded))
                .padding(.horizontal, 8).frame(minHeight: 36)
                .background(on ? Tokens.accent.color : Tokens.canvasBase.color, in: RoundedRectangle(cornerRadius: 4))
                .foregroundStyle(on ? Tokens.canvasBase.color : Tokens.white.color)
        }
        .buttonStyle(.plain)
    }
}

/// The rally timeline (Section 3.5.7): phase markers, play, and the selected item's keyframe at the marker.
/// Edits made while resting on a later marker become keyframes there; the first marker holds the base scene.
struct TimelineStrip: View {
    let controller: StudioController

    var body: some View {
        HStack(spacing: 6) {
            if controller.scene.timeline.isEmpty {
                chip("ANIMATE BY PHASE", on: false) { controller.enableTimeline() }
                    .accessibilityHint("Adds the markers serve to defence; players and zones can then change per phase")
            } else {
                Button { controller.togglePlay() } label: {
                    Image(systemName: controller.playing ? "stop.fill" : "play.fill")
                        .font(.system(size: 16, weight: .bold))
                        .frame(width: 44, height: 36)
                        .background(Tokens.accent.color, in: RoundedRectangle(cornerRadius: 4))
                        .foregroundStyle(Tokens.canvasBase.color)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(controller.playing ? "Stop" : "Play the rally")
                ForEach(controller.scene.timeline, id: \.self) { phase in
                    let on = controller.currentPhase == phase
                    Button { controller.go(to: phase) } label: {
                        VStack(spacing: 2) {
                            Text(phase.title).font(.system(size: 11, weight: .bold).width(.expanded))
                            Circle().frame(width: 5, height: 5)
                                .opacity(controller.selectionHasKey(at: phase) ? 1 : 0)
                        }
                        .padding(.horizontal, 8).frame(minHeight: 36)
                        .background(on ? Tokens.accent.color : Tokens.canvasBase.color, in: RoundedRectangle(cornerRadius: 4))
                        .foregroundStyle(on ? Tokens.canvasBase.color : Tokens.white.color)
                    }
                    .buttonStyle(.plain)
                }
                if controller.selectedToken != nil || controller.selectedZone != nil, let phase = controller.currentPhase,
                   controller.scene.timeline.first != phase {
                    Divider().frame(height: 28).overlay(Tokens.hairline.color)
                    if controller.selectionHasKey(at: phase) {
                        chip("CLEAR KEY", on: false) { controller.clearSelectionKey() }
                    } else {
                        chip("HOLD HERE", on: false) { controller.pinSelection() }
                    }
                    if controller.selectedZone != nil {
                        let hidden = (controller.frame.intensities[controller.selectedZone!] ?? 1) < 0.5
                        chip(hidden ? "SHOW" : "HIDE", on: hidden) { controller.toggleSelectedZoneVisibility() }
                    }
                }
                Divider().frame(height: 28).overlay(Tokens.hairline.color)
                chip("STATIC", on: false) { controller.disableTimeline() }
            }
        }
        .padding(10)
        .background(Tokens.canvasRaised.withAlpha(0.96).color, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Tokens.hairline.color))
    }

    private func chip(_ title: String, on: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(.system(size: 11, weight: .bold).width(.expanded))
                .padding(.horizontal, 8).frame(minHeight: 36)
                .background(on ? Tokens.accent.color : Tokens.canvasBase.color, in: RoundedRectangle(cornerRadius: 4))
                .foregroundStyle(on ? Tokens.canvasBase.color : Tokens.white.color)
        }
        .buttonStyle(.plain)
    }
}

/// POV controls (Section 5.1): fly into the selected player's eyes, gaze rays on or off, back to the orbit camera.
struct POVStrip: View {
    let controller: StudioController

    var body: some View {
        HStack(spacing: 6) {
            if let pov = controller.povPlayer {
                let label = controller.scene.tokens.first { $0.id == pov }?.label ?? ""
                Text("POV \(label) \u{00B7} HEAD-LOCKED").font(.system(size: 10, weight: .semibold).width(.expanded))
                    .foregroundStyle(Tokens.textSecondary.color)
                chip("LOOK AHEAD", on: controller.povYaw == 0 && controller.povPitch == 0) { controller.look(dx: controller.povYaw, dy: -controller.povPitch) }
                if controller.selectedToken != nil && controller.selectedToken != pov {
                    chip("POV \(controller.selectedTokenValue?.label ?? "")", on: false) { controller.enterPOV() }
                }
                chip("EXIT POV", on: true) { controller.exitPOV() }
            } else if let token = controller.selectedTokenValue {
                chip("POV \(token.label)", on: false) { controller.enterPOV() }
                    .accessibilityLabel("See through the eyes of \(token.label)")
                chip("GAZE", on: controller.gazePlayer == token.id) { controller.toggleGaze() }
                    .accessibilityLabel("Gaze rays and field of view of \(token.label)")
            }
        }
        .padding(10)
        .background(Tokens.canvasRaised.withAlpha(0.96).color, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Tokens.accent.withAlpha(0.5).color))
    }

    private func chip(_ title: String, on: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(.system(size: 11, weight: .bold).width(.expanded))
                .padding(.horizontal, 8).frame(minHeight: 36)
                .background(on ? Tokens.accent.color : Tokens.canvasBase.color, in: RoundedRectangle(cornerRadius: 4))
                .foregroundStyle(on ? Tokens.canvasBase.color : Tokens.white.color)
        }
        .buttonStyle(.plain)
    }
}

/// Gaze readouts (Section 5.6): one line per target with its band and visibility.
struct GazePanel: View {
    let controller: StudioController

    var body: some View {
        let readouts = controller.gazeReadouts
        VStack(alignment: .leading, spacing: 6) {
            Text("LINE OF SIGHT").font(.system(size: 10, weight: .semibold).width(.expanded))
                .foregroundStyle(Tokens.textSecondary.color)
            if readouts.isEmpty {
                Text(controller.povPlayer != nil ? "Tap a player to add a target" : "No targets")
                    .font(.system(size: 12)).foregroundStyle(Tokens.textSecondary.color)
            }
            ForEach(readouts, id: \.self) { r in
                HStack(spacing: 6) {
                    Circle().fill((r.visibility.fraction >= 0.5 ? Tokens.white : RGBA(hex: 0xFF3B1A)).color).frame(width: 8, height: 8)
                    Text(r.text).font(.system(size: 12, weight: .medium)).foregroundStyle(Tokens.white.color)
                }
            }
            if controller.povPlayer != nil {
                Text("Head orientation, not eye tracking: the rings show the central field around where the head points.")
                    .font(.system(size: 10)).foregroundStyle(Tokens.textSecondary.color)
                    .frame(maxWidth: 300, alignment: .leading)
            }
        }
        .padding(10)
        .background(Tokens.canvasRaised.withAlpha(0.92).color, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Tokens.hairline.color))
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
                Circle().stroke(Tokens.white.withAlpha(0.7).color, lineWidth: 1)
                    .frame(width: foveal * 2, height: foveal * 2)
            }
            .position(x: g.size.width / 2, y: g.size.height / 2)
        }
    }
}

/// Ball contacts at the current marker (Section 5.4): who plays the ball and how; the physics flies it to the
/// next contact. The readout describes the flight in the air at the current moment.
struct BallStrip: View {
    let controller: StudioController

    var body: some View {
        HStack(spacing: 6) {
            Text("BALL").font(.system(size: 10, weight: .semibold).width(.expanded))
                .foregroundStyle(Tokens.textSecondary.color)
            if let phase = controller.currentPhase, let selected = controller.selectedTokenValue {
                let contact = controller.currentContact
                if contact?.player == selected.id, let kind = contact?.kind {
                    ForEach(ContactKind.choices(at: phase), id: \.self) { k in
                        chip(k.title, on: k == kind) { controller.setContact(k) }
                    }
                    chip("NO BALL", on: false) { controller.removeContact() }
                    if controller.currentContactIsLast {
                        chip(controller.aimingLanding ? "TAP THE FLOOR" : "AIM", on: controller.aimingLanding) { controller.aimLanding() }
                    }
                } else {
                    chip(contact == nil ? "\(selected.label) PLAYS IT" : "\(selected.label) PLAYS IT INSTEAD", on: false) {
                        controller.setContact()
                    }
                }
            } else if controller.scene.contacts == nil {
                Text("Select a player on a marker to place the first contact")
                    .font(.system(size: 12)).foregroundStyle(Tokens.textSecondary.color)
            }
            if let summary = controller.ballSummary {
                Text(summary).font(.dataMono).foregroundStyle(Tokens.white.color).lineLimit(1)
            }
        }
        .padding(10)
        .background(Tokens.canvasRaised.withAlpha(0.96).color, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Tokens.hairline.color))
    }

    private func chip(_ title: String, on: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(.system(size: 11, weight: .bold).width(.expanded))
                .padding(.horizontal, 8).frame(minHeight: 36)
                .background(on ? Tokens.accent.color : Tokens.canvasBase.color, in: RoundedRectangle(cornerRadius: 4))
                .foregroundStyle(on ? Tokens.canvasBase.color : Tokens.white.color)
        }
        .buttonStyle(.plain)
    }
}
