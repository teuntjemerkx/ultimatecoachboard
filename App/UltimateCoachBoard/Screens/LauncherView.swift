import SwiftUI

/// Screen 1: three tiles, Quick Match one tap away (Appendix C2).
struct LauncherView: View {
    @Bindable var model: AppModel

    var body: some View {
        VStack(spacing: 32) {
            Text("THE ULTIMATE COACH BOARD")
                .font(.system(size: 15, weight: .semibold).width(.expanded))
                .foregroundStyle(Tokens.textSecondary.color)
            HStack(spacing: 24) {
                tile(title: "MATCH", subtitle: model.lastSetup == nil ? "Set up a match" : "New lineup",
                     enabled: true, action: model.newMatch) {
                    if model.lastSetup != nil {
                        Button { model.quickMatch() } label: {
                            Text("QUICK MATCH")
                                .font(.system(size: 13, weight: .bold).width(.expanded))
                                .padding(.horizontal, 14).frame(height: 44)
                                .background(Tokens.accent.color, in: RoundedRectangle(cornerRadius: 4))
                                .foregroundStyle(Tokens.canvasBase.color)
                        }
                    }
                }
                tile(title: "TRAINING", subtitle: "Drill Architect \u{2014} phase 2", enabled: false, action: {}) { EmptyView() }
                tile(title: "STUDIO", subtitle: "2D/3D analysis \u{2014} phase 2", enabled: false, action: {}) { EmptyView() }
            }
            if model.resumable != nil {
                Button { model.resume() } label: {
                    Label("Resume unfinished match", systemImage: "arrow.clockwise")
                        .font(.system(size: 15, weight: .semibold))
                        .padding(.horizontal, 20).frame(height: 52)
                        .overlay(RoundedRectangle(cornerRadius: 4).stroke(Tokens.accent.color, lineWidth: 1.5))
                }
                .foregroundStyle(Tokens.white.color)
            }
        }
        .padding(40)
    }

    private func tile<Extra: View>(title: String, subtitle: String, enabled: Bool, action: @escaping () -> Void,
                                   @ViewBuilder extra: () -> Extra) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(.system(size: 28, weight: .bold).width(.expanded))
            Text(subtitle).font(.system(size: 15)).foregroundStyle(Tokens.textSecondary.color)
            Spacer()
            extra()
        }
        .padding(20)
        .frame(width: 280, height: 200, alignment: .topLeading)
        .background(Tokens.canvasRaised.color, in: RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(enabled ? Tokens.accent.color : Tokens.hairline.color, lineWidth: enabled ? 2 : 1))
        .foregroundStyle(enabled ? Tokens.white.color : Tokens.textSecondary.color)
        .contentShape(Rectangle())
        .onTapGesture { if enabled { action() } }
        .opacity(enabled ? 1 : 0.55)
    }
}
