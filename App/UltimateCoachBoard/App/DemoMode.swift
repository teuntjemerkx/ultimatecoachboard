import UIKit
import CoachBoardCore

/// Launch-argument demo states (`-demoScreen launcher|setup|live|setbreak|log`) so CI can capture screenshots of
/// real screens in the Simulator. Only reachable through launch arguments; never shown to a coach.
enum DemoMode {
    static var screen: String? {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-demoScreen"), args.indices.contains(i + 1) else { return nil }
        return args[i + 1]
    }

    static var setup: MatchSetupData {
        var s = MatchSetupData()
        s.homeName = "Orion"
        s.opponentName = "Dynamo"
        let numbers = [8, 12, 4, 9, 14, 2]           // P1...P6 with the setter (#8) in P1
        s.homeSlots = numbers.map { SlotPlayer(id: UUID(), jersey: $0, name: nil) }
        s.homeLibero = SlotPlayer(id: UUID(), jersey: 6, name: nil)
        s.setterPosition = 1
        s.opponentNumbers = [3, 11, 7, 10, 5, 1]
        s.opponentSetterPosition = 1
        s.firstServer = .opponent
        return s
    }

    /// Prepares the requested state on the model.
    @MainActor
    static func apply(to model: AppModel) {
        guard let screen else { return }
        note("demo screen \(screen)")
        switch screen {
        case "setup":
            model.screen = .setup
        case "live":
            guard let c = try? LiveController(setup: setup) else { return }
            play(c, rallies: [.home, .home, .opponent, .home], scout: true)
            c.routesVisible = true
            model.screen = .live(c)
        case "setbreak":
            guard let c = try? LiveController(setup: setup) else { return }
            playSet(c)
            model.screen = .live(c)
        case "log":
            guard let c = try? LiveController(setup: setup) else { return }
            playSet(c)
            c.close()
            // Give the journal actor its group commit, then open the log of this match.
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 800_000_000)
                if let s = MatchArchive.list().first { model.screen = .matchLog(s) }
            }
        default:
            model.refreshArchive()
        }
    }

    @MainActor
    private static func play(_ c: LiveController, rallies: [Side], scout: Bool) {
        for (i, w) in rallies.enumerated() {
            if scout && i % 2 == 0 { scoutAttack(c, i) }
            c.swipe(winner: w)
        }
    }

    @MainActor
    private static func playSet(_ c: LiveController) {
        var i = 0
        while c.state.context == .live && i < 80 {
            if i % 3 == 0 { scoutAttack(c, i) }
            c.swipe(winner: i % 3 == 2 ? .opponent : .home)
            i += 1
        }
    }

    /// Two scouting taps: origin in the opponent's front court, landing in the home half.
    @MainActor
    private static func scoutAttack(_ c: LiveController, _ i: Int) {
        let g = c.geometry
        guard g.size.width > 0 else {
            c.boardSize = CGSize(width: 1100, height: 700)
            return scoutAttack(c, i)
        }
        let origin = g.toView(LocalPoint(l: [1.0, 4.5, 8.0][i % 3], d: 1.0), side: .opponent)
        let landing = g.toView(LocalPoint(l: [7.5, 2.0, 4.5, 1.2][i % 4], d: [6.0, 3.5, 8.0, 2.0][i % 4]), side: .home)
        c.tap(at: origin)
        c.tap(at: landing)
    }

    /// Appends a line to Documents/demo-diagnostics.txt, which CI publishes next to the screenshots.
    static func note(_ line: String) {
        guard screen != nil,
              let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else { return }
        let url = dir.appendingPathComponent("demo-diagnostics.txt")
        let data = Data((line + "\n").utf8)
        if let h = try? FileHandle(forWritingTo: url) {
            _ = try? h.seekToEnd()
            try? h.write(contentsOf: data)
            try? h.close()
        } else {
            try? data.write(to: url)
        }
    }
}
