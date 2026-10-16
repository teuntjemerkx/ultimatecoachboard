import SwiftUI
import MetalKit
import CoachBoardCore

/// The court canvas: an MTKView with the gesture grammar of Section 1.5.
final class BoardMTKView: MTKView, UIGestureRecognizerDelegate {
    var onTap: ((CGPoint) -> Void)?
    var onUndo: (() -> Void)?
    var onRedo: (() -> Void)?
    var onDragBegan: ((CGPoint) -> Bool)?
    var onDragChanged: ((CGPoint) -> Void)?
    var onDragEnded: (() -> Void)?
    var onInk: (([CGPoint]) -> Void)?
    var onResize: ((CGSize) -> Void)?
    /// Every step of a one-finger pan (Studio: drawing zones and ink, moving tokens and zones).
    enum PanPhase { case began, changed, ended, cancelled }
    var onPanEvent: ((PanPhase, CGPoint) -> Void)?
    /// 3D: two-finger pan orbits (translation delta in points), pinch dollies (scale delta).
    var onOrbit: ((CGPoint) -> Void)?
    var onPinch: ((CGFloat) -> Void)?

    var orbitEnabled = false {
        didSet {
            orbitPan.isEnabled = orbitEnabled
            pinch.isEnabled = orbitEnabled
        }
    }

    /// In Panic the one-finger pan draws; elsewhere it is disabled so taps stay instant.
    var drawingEnabled = false {
        didSet {
            inkPan.isEnabled = drawingEnabled
            longPress.isEnabled = !drawingEnabled
        }
    }

    private lazy var tap = UITapGestureRecognizer(target: self, action: #selector(handleTap(_:)))
    private lazy var twoFingerTap: UITapGestureRecognizer = {
        let g = UITapGestureRecognizer(target: self, action: #selector(handleUndo(_:)))
        g.numberOfTouchesRequired = 2
        return g
    }()
    private lazy var threeFingerTap: UITapGestureRecognizer = {
        let g = UITapGestureRecognizer(target: self, action: #selector(handleRedo(_:)))
        g.numberOfTouchesRequired = 3
        return g
    }()
    private lazy var longPress: UILongPressGestureRecognizer = {
        let g = UILongPressGestureRecognizer(target: self, action: #selector(handleLongPress(_:)))
        g.minimumPressDuration = 0.35
        g.allowableMovement = 12          // tremor filter (Section 2.9)
        return g
    }()
    private lazy var inkPan: UIPanGestureRecognizer = {
        let g = UIPanGestureRecognizer(target: self, action: #selector(handleInk(_:)))
        g.maximumNumberOfTouches = 1
        g.isEnabled = false
        return g
    }()
    private lazy var orbitPan: UIPanGestureRecognizer = {
        let g = UIPanGestureRecognizer(target: self, action: #selector(handleOrbit(_:)))
        g.minimumNumberOfTouches = 2
        g.maximumNumberOfTouches = 2
        g.isEnabled = false
        g.delegate = self
        return g
    }()
    private lazy var pinch: UIPinchGestureRecognizer = {
        let g = UIPinchGestureRecognizer(target: self, action: #selector(handlePinch(_:)))
        g.isEnabled = false
        g.delegate = self
        return g
    }()
    private var inkPoints: [CGPoint] = []
    /// Apple Pencil Pro is the only haptic device an iPad coach holds; a completed ink stroke is confirmed on it.
    private lazy var canvasFeedback = UICanvasFeedbackGenerator(view: self)
    private var lastSize: CGSize = .zero
    private var dragActive = false

    override init(frame: CGRect, device: MTLDevice?) {
        super.init(frame: frame, device: device)
        configure()
    }

    required init(coder: NSCoder) {
        super.init(coder: coder)
        configure()
    }

    private func configure() {
        isMultipleTouchEnabled = true
        for g in [tap, twoFingerTap, threeFingerTap, longPress, inkPan, orbitPan, pinch] as [UIGestureRecognizer] { addGestureRecognizer(g) }
        tap.require(toFail: twoFingerTap)
        accessibilityLabel = "Volleyball court"
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        if bounds.size != lastSize {
            lastSize = bounds.size
            onResize?(bounds.size)
        }
    }

    @objc private func handleTap(_ g: UITapGestureRecognizer) { onTap?(g.location(in: self)) }
    @objc private func handleUndo(_ g: UITapGestureRecognizer) { onUndo?() }
    @objc private func handleRedo(_ g: UITapGestureRecognizer) { onRedo?() }

    @objc private func handleOrbit(_ g: UIPanGestureRecognizer) {
        guard g.state == .changed else { return }
        onOrbit?(g.translation(in: self))
        g.setTranslation(.zero, in: self)
    }

    @objc private func handlePinch(_ g: UIPinchGestureRecognizer) {
        guard g.state == .changed else { return }
        onPinch?(g.scale)
        g.scale = 1
    }

    /// Orbit and pinch run together, so a two-finger gesture can turn and zoom at once.
    func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        (g === orbitPan && other === pinch) || (g === pinch && other === orbitPan)
    }

    @objc private func handleLongPress(_ g: UILongPressGestureRecognizer) {
        let p = g.location(in: self)
        switch g.state {
        case .began:
            dragActive = onDragBegan?(p) == true
        case .changed:
            if dragActive { onDragChanged?(p) }
        default:
            if dragActive { onDragEnded?() }
            dragActive = false
        }
    }

    @objc private func handleInk(_ g: UIPanGestureRecognizer) {
        let p = g.location(in: self)
        switch g.state {
        case .began:
            inkPoints = [p]
            onPanEvent?(.began, p)
        case .changed:
            inkPoints.append(p)
            onPanEvent?(.changed, p)
        case .ended:
            inkPoints.append(p)
            onInk?(inkPoints)
            onPanEvent?(.ended, p)
            inkPoints = []
            canvasFeedback.pathCompleted(at: p)
        default:
            inkPoints = []
            onPanEvent?(.cancelled, p)
        }
    }
}

/// SwiftUI host for the board.
struct BoardView: UIViewRepresentable {
    let controller: LiveController

    final class Coordinator {
        var renderer: BoardRenderer?
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> BoardMTKView {
        let view = BoardMTKView(frame: .zero, device: MTLCreateSystemDefaultDevice())
        context.coordinator.renderer = BoardRenderer(view: view)
        let c = controller
        view.onTap = { c.tap(at: $0) }
        view.onUndo = { c.undo() }
        view.onRedo = { c.redo() }
        view.onDragBegan = { c.dragBegan(at: $0) }
        view.onDragChanged = { c.dragChanged(to: $0) }
        view.onDragEnded = { c.dragEnded() }
        view.onInk = { c.ink($0) }
        view.onResize = { size in DispatchQueue.main.async { c.boardSize = size } }
        return view
    }

    func updateUIView(_ view: BoardMTKView, context: Context) {
        _ = Tokens.theme.id                    // a template change redraws the board
        var geometry = controller.geometry
        geometry.size = view.bounds.size
        if case .panicTimeOut = controller.state.context { view.drawingEnabled = true } else { view.drawingEnabled = false }
        guard let renderer = context.coordinator.renderer else { return }
        renderer.geometry = geometry
        renderer.scene = controller.boardScene
        renderer.requestRedraw()
    }
}
