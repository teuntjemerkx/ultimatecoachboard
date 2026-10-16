import SwiftUI
import SwiftData

@main
struct UltimateCoachBoardApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView(model: model)
                .preferredColorScheme(.dark)
                .tint(Tokens.accent.color)
        }
        .modelContainer(for: [Team.self, Player.self])
    }
}

struct RootView: View {
    @Bindable var model: AppModel

    var body: some View {
        ZStack {
            Tokens.canvasBase.color.ignoresSafeArea()
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
        .sheet(isPresented: $model.showSettings) { SettingsView() }
        .alert("Something went wrong", isPresented: Binding(get: { model.errorMessage != nil },
                                                             set: { if !$0 { model.errorMessage = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.errorMessage ?? "")
        }
    }
}
