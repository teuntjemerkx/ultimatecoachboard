import SwiftUI
import SwiftData

@main
struct UltimateCoachBoardApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView(model: model)
        }
        .modelContainer(for: [Team.self, Player.self])
    }
}

struct RootView: View {
    @Bindable var model: AppModel

    var body: some View {
        ZStack {
            Tokens.background.color.ignoresSafeArea()
            switch model.screen {
            case .launcher:
                LauncherView(model: model)
            case .setup:
                MatchSetupView(initial: model.lastSetup ?? MatchSetupData(), onStart: { model.start($0) },
                               onCancel: { model.backToLauncher() })
            case .roster:
                RosterView(onDone: { model.backToLauncher() })
            case .live(let controller):
                LiveView(controller: controller, onExit: { model.backToLauncher() })
            case .matchLog(let summary):
                MatchLogView(summary: summary, onClose: { model.backToLauncher() }, onResume: { model.resume($0) })
            case .studio(let controller):
                StudioView(controller: controller, onExit: { model.backToLauncher() })
            }
        }
        // The template decides light or dark for system controls and sheets; Tokens are read here, so a template
        // change re-renders the whole tree.
        .preferredColorScheme(Tokens.theme.isDark ? .dark : .light)
        .tint(Tokens.accent.color)
        .sheet(isPresented: $model.showSettings) { SettingsView() }
        .alert("Something went wrong", isPresented: Binding(get: { model.errorMessage != nil },
                                                             set: { if !$0 { model.errorMessage = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.errorMessage ?? "")
        }
    }
}
