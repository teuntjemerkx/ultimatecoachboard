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
