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
                    if controller.view3D && controller.selectedTokenValue != nil {
                        VStack {
                            Spacer()
                            PostureStrip(controller: controller).padding(.bottom, 16)
                        }
                        .frame(maxWidth: .infinity)
                    }
                    if controller.scene.zones.isEmpty && controller.scene.ink.isEmpty {
                        VStack {
                            Spacer()
                            Text("Draw a zone or drag a player").font(.system(size: 15))
                                .foregroundStyle(Tokens.textSecondary.color)
                                .padding(.bottom, 24)
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
        view.onOrbit = { d in if let r = coordinator.renderer { Self.orbit(r, by: d) } }
        view.onPinch = { s in
            guard let r = coordinator.renderer else { return }
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
                chip("AUTO", on: token.posture == nil) { controller.setPosture(nil) }
                ForEach(Posture.allCases, id: \.self) { p in
                    chip(p.rawValue.uppercased(), on: token.posture == p) { controller.setPosture(p) }
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
