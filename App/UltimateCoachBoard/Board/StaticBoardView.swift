import SwiftUI
import MetalKit
import CoachBoardCore

extension MatchStartedPayload {
    /// Token labels: jersey numbers where known, otherwise the template role.
    var playerLabels: [PlayerID: String] {
        var out: [PlayerID: String] = [:]
        for sheet in [home, opponent] {
            for (id, role) in sheet.roles {
                out[id] = jerseys?[id].map { String($0) } ?? role
            }
        }
        for (id, n) in jerseys ?? [:] where out[id] == nil { out[id] = String(n) }   // bench players
        return out
    }
}

extension BoardScene {
    /// A read-only snapshot for the Match Log: tokens in their formations and the given attack lines.
    static func snapshot(_ state: LiveState, labels: [PlayerID: String], lines: [ScoutLine]) -> BoardScene {
        var scene = BoardScene()
        for t in state.tokens() {
            scene.tokens.append(.init(id: t.player, side: t.side, point: CourtFrame.world(t.point, of: t.side),
                                      label: labels[t.player] ?? t.role, isLibero: t.isLibero, isServer: t.isServer,
                                      selected: false))
        }
        for line in lines {
            scene.scoutLines.append((CourtFrame.world(line.originRaw, of: .opponent), CourtFrame.world(line.landingRaw, of: .home), 1))
        }
        return scene
    }
}

/// The Metal board without gestures, for read-only views (Match Log).
struct StaticBoardView: UIViewRepresentable {
    let scene: BoardScene
    var homeOnLeft = true

    final class Coordinator {
        var renderer: BoardRenderer?
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> BoardMTKView {
        let view = BoardMTKView(frame: .zero, device: MTLCreateSystemDefaultDevice())
        let renderer = BoardRenderer(view: view)
        context.coordinator.renderer = renderer
        let coordinator = context.coordinator
        view.onResize = { size in
            coordinator.renderer?.geometry.size = size
            coordinator.renderer?.requestRedraw()
        }
        view.isUserInteractionEnabled = false
        return view
    }

    func updateUIView(_ view: BoardMTKView, context: Context) {
        guard let renderer = context.coordinator.renderer else { return }
        renderer.geometry = BoardGeometry(size: view.bounds.size, homeOnLeft: homeOnLeft)
        renderer.scene = scene
        renderer.requestRedraw()
    }
}
