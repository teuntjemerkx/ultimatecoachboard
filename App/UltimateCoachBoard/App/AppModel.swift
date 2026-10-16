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
        case live(LiveController)
    }

    var screen: Screen = .launcher
    private(set) var lastSetup: MatchSetupData?
    private(set) var resumable: URL?
    var errorMessage: String?

    init() {
        lastSetup = Self.loadSetup()
        resumable = Self.findResumableJournal()
    }

    func newMatch() { screen = .setup }

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
        guard let lastSetup else { return newMatch() }
        start(lastSetup)
    }

    func resume() {
        guard let url = resumable else { return }
        do {
            screen = .live(try LiveController(resuming: url))
        } catch {
            errorMessage = "Could not resume: \(error.localizedDescription)"
        }
    }

    func exitLive() {
        screen = .launcher
        resumable = Self.findResumableJournal()
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

    /// The newest journal whose match has not ended (Appendix B3 recovery).
    private static func findResumableJournal() -> URL? {
        guard let dir = try? JournalPipe.journalsDirectory(),
              let files = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) else { return nil }
        var best: (URL, Int64)?
        for url in files where url.pathExtension == "cbj" {
            guard let data = try? Data(contentsOf: url), let read = try? JournalCodec.read(data),
                  read.records.count > 1, read.records.last?.knownType != .matchEnded else { continue }
            if best == nil || read.header.createdAtNanoseconds > best!.1 { best = (url, read.header.createdAtNanoseconds) }
        }
        return best?.0
    }
}
