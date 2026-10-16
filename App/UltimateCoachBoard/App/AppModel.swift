import Foundation
import Observation
import CoachBoardCore

/// Top-level navigation and the small amount of state that outlives a match.
@MainActor
@Observable
final class AppModel {
    enum Screen {
        case launcher
        case setup
        case roster
        case live(LiveController)
        case matchLog(MatchSummary)
        case studio(StudioController)
    }

    var screen: Screen = .launcher
    private(set) var lastSetup: MatchSetupData?
    /// Saved matches, newest first (the launcher's recents strip).
    private(set) var recents: [MatchSummary] = []
    var errorMessage: String?
    var showSettings = false

    /// The newest match that has rallies but has not ended (Appendix B3 recovery).
    var resumable: MatchSummary? { recents.first { !$0.finished && $0.rallies > 0 } }

    init() {
        lastSetup = Self.loadSetup()
        refreshArchive()
        if DemoMode.screen != nil {
            lastSetup = DemoMode.setup
            DemoMode.apply(to: self)
        }
    }

    func refreshArchive() {
        Task {
            let list = await Task.detached(priority: .userInitiated) { MatchArchive.list() }.value
            recents = list
        }
    }

    func newMatch() { screen = .setup }

    func openRoster() { screen = .roster }

    /// Studio opens the most recent scene, or a new one with the last lineup's numbers on the home formation.
    func openStudio() {
        if let latest = SceneStore.list().first {
            screen = .studio(StudioController(scene: latest))
            return
        }
        // The scene shows R1 (setter in P1); the setup's lineup started with the setter in P_s, so the player
        // for R1's P_i stood in P_((i - 1 + s - 1) mod 6 + 1) of the setup.
        var labels: [CourtPosition: String] = [:]
        if let setup = lastSetup {
            let s = setup.system.hasSetter ? setup.setterPosition : 1
            for i in 1...6 {
                let j = (i - 1 + s - 1) % 6
                if let slot = setup.homeSlots[j], let pos = CourtPosition(rawValue: i) { labels[pos] = String(slot.jersey) }
            }
        }
        let scene = SceneStore.newScene(system: lastSetup?.system ?? .fiveOneOutside, labels: labels)
        SceneStore.save(scene)
        screen = .studio(StudioController(scene: scene))
    }

    func start(_ setup: MatchSetupData) {
        Self.saveSetup(setup)
        lastSetup = setup
        do {
            screen = .live(try LiveController(setup: setup))
        } catch {
            errorMessage = "Could not start the match: \(error.localizedDescription)"
            screen = .launcher
        }
    }

    func quickMatch() {
        guard let lastSetup, lastSetup.homeSlots.allSatisfy({ $0 != nil }) else { return newMatch() }
        start(lastSetup)
    }

    func resume(_ url: URL) {
        do {
            screen = .live(try LiveController(resuming: url))
        } catch {
            errorMessage = "Could not resume: \(error.localizedDescription)"
        }
    }

    /// A recent card reopens exactly where it was left: a match in progress goes back to Live, a finished one to its log.
    func open(_ summary: MatchSummary) {
        if summary.finished || summary.rallies == 0 { screen = .matchLog(summary) } else { resume(summary.url) }
    }

    func delete(_ summary: MatchSummary) {
        do {
            try MatchArchive.moveToDeleted(summary.url)
        } catch {
            errorMessage = "Could not delete: \(error.localizedDescription)"
        }
        refreshArchive()
    }

    func backToLauncher() {
        screen = .launcher
        refreshArchive()
    }

    // MARK: - Persistence of the last setup (Quick Match)

    private static var setupURL: URL? {
        try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("last-setup.json")
    }

    private static func loadSetup() -> MatchSetupData? {
        guard let url = setupURL, let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(MatchSetupData.self, from: data)
    }

    private static func saveSetup(_ setup: MatchSetupData) {
        guard let url = setupURL, let data = try? JSONEncoder().encode(setup) else { return }
        try? data.write(to: url, options: .atomic)
    }
}
