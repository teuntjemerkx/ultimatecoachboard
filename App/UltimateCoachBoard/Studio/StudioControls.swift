import SwiftUI
import CoachBoardCore

/// Shared look of the Studio's floating controls: a raised panel with a hairline edge, and chips that read as
/// buttons at arm's length (44 pt targets, 13 pt bold labels).
struct StudioPanel: ViewModifier {
    var emphasis = false

    func body(content: Content) -> some View {
        content
            .padding(10)
            .background(Tokens.canvasRaised.withAlpha(0.97).color, in: RoundedRectangle(cornerRadius: Tokens.cornerRadius))
            .overlay(RoundedRectangle(cornerRadius: Tokens.cornerRadius)
                .stroke((emphasis ? Tokens.accent.withAlpha(0.5) : Tokens.hairline).color))
            .shadow(color: .black.opacity(0.08), radius: 8, y: 2)
    }
}

extension View {
    func studioPanel(emphasis: Bool = false) -> some View { modifier(StudioPanel(emphasis: emphasis)) }
}

struct StudioChip: View {
    let title: String
    var symbol: String?
    var on = false
    var prominent = false
    let action: () -> Void

    init(_ title: String, symbol: String? = nil, on: Bool = false, prominent: Bool = false, action: @escaping () -> Void) {
        self.title = title
        self.symbol = symbol
        self.on = on
        self.prominent = prominent
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if let symbol { Image(systemName: symbol).font(.themed(13, .bold)) }
                Text(title).font(.themed(13, .bold)).lineLimit(1)
            }
            .padding(.horizontal, 12).frame(minHeight: 44)
            .background(fill, in: RoundedRectangle(cornerRadius: Tokens.radiusSmall))
            .foregroundStyle(on || prominent ? Tokens.onAccent.color : Tokens.text.color)
        }
        .buttonStyle(.plain)
    }

    private var fill: Color {
        if prominent { return Tokens.accentActive.color }
        return on ? Tokens.accent.color : Tokens.canvasBase.color
    }
}

extension RallyPhase {
    /// Plain names on the timeline: the receive marker is the pass.
    var displayName: String {
        switch self {
        case .serve: return "Serve"
        case .receive: return "Pass"
        case .set: return "Set"
        case .attack: return "Attack"
        case .cover: return "Cover"
        case .defence: return "Defence"
        }
    }
}

extension TeamSystem {
    /// Short names for the lineup menu.
    var shortName: String {
        switch self {
        case .fiveOneOutside: return "5-1"
        case .fiveOneMiddle: return "5-1 (middle)"
        case .sixTwo: return "6-2"
        case .fourTwo: return "4-2"
        case .youthW: return "Youth W"
        }
    }
}

/// The lineup in one row (the Studio's main control): the system, the rotation (the arrow moves on as after a
/// side-out), who serves, and one tap to play a rally out. Advanced adds the opponent's system and rotation.
struct LineupBar: View {
    let controller: StudioController
    private var advanced: Bool { ThemeStore.shared.advanced }

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 16) {
                lineup
                Divider().frame(height: 36).overlay(Tokens.hairline.color)
                rally
            }
            VStack(alignment: .leading, spacing: 10) {
                lineup
                rally
            }
        }
        .studioPanel()
    }

    private var lineup: some View {
        let setup = controller.setup
        return HStack(spacing: 10) {
            systemMenu(.home, title: advanced ? "Us" : nil)
            rotationStepper(.home, rotation: setup.homeRotation)
            serveToggle(homeServes: setup.homeServes)
            if advanced {
                Divider().frame(height: 36).overlay(Tokens.hairline.color)
                systemMenu(.opponent, title: "Them")
                rotationStepper(.opponent, rotation: setup.opponentRotation)
            }
        }
    }

    private var rally: some View {
        HStack(spacing: 8) {
            Text("Play a rally").font(.themed(13, .semibold)).foregroundStyle(Tokens.textSecondary.color)
            ForEach(AttackOption.allCases, id: \.self) { option in
                let current = !controller.scene.timeline.isEmpty && controller.setup.attack == option
                StudioChip(option.title, symbol: current ? "play.fill" : nil, on: current) { controller.playRally(option) }
                    .accessibilityLabel("Play a rally with the attack on the \(option.title.lowercased())")
            }
        }
    }

    private func systemMenu(_ side: Side, title: String?) -> some View {
        let current = TeamSystem(rawValue: controller.setup.system(side)) ?? .fiveOneOutside
        return Menu {
            ForEach(TeamSystem.allCases, id: \.self) { system in
                Button(system.displayName) {
                    controller.changeSetup { s in
                        let t = try? TemplateLibrary.template(id: system.templateID)
                        let r = t?.rotations.first ?? 1
                        if side == .home { s.homeSystem = system.templateID; s.homeRotation = r } else {
                            s.opponentSystem = system.templateID; s.opponentRotation = r
                        }
                    }
                }
            }
        } label: {
            HStack(spacing: 6) {
                if let title { Text(title).font(.themed(13, .semibold)).foregroundStyle(Tokens.textSecondary.color) }
                Text(current.shortName).font(.themed(15, .bold))
                Image(systemName: "chevron.down").font(.themed(11, .bold))
            }
            .padding(.horizontal, 12).frame(minHeight: 44)
            .background(Tokens.canvasBase.color, in: RoundedRectangle(cornerRadius: Tokens.radiusSmall))
            .foregroundStyle(Tokens.text.color)
        }
        .accessibilityLabel(side == .home ? "Our system: \(current.displayName)" : "Their system: \(current.displayName)")
    }

    private func rotationStepper(_ side: Side, rotation: Int) -> some View {
        let many = controller.rotations(side).count > 1
        return HStack(spacing: 0) {
            Button { controller.rotate(side, forward: false) } label: {
                Image(systemName: "chevron.left").font(.themed(15, .bold)).frame(width: 44, height: 44)
            }
            .accessibilityLabel("Previous rotation")
            VStack(spacing: 0) {
                Text(rotation == 0 ? "Any rotation" : "Rotation \(rotation)").font(.themed(15, .bold)).monospacedDigit()
                if advanced && rotation > 0 {
                    Text("setter in zone \(rotation)").font(.themed(11, .medium)).foregroundStyle(Tokens.textSecondary.color)
                }
            }
            .frame(minWidth: 104)
            Button { controller.rotate(side) } label: {
                Image(systemName: "chevron.right").font(.themed(15, .bold)).frame(width: 44, height: 44)
            }
            .accessibilityLabel("Next rotation, as after a side-out")
        }
        .foregroundStyle(Tokens.text.color)
        .background(Tokens.canvasBase.color, in: RoundedRectangle(cornerRadius: Tokens.radiusSmall))
        .disabled(!many)
        .opacity(many ? 1 : 0.5)
    }

    private func serveToggle(homeServes: Bool) -> some View {
        HStack(spacing: 4) {
            Text("Serve").font(.themed(13, .semibold)).foregroundStyle(Tokens.textSecondary.color)
            StudioChip("Us", on: homeServes) { if !homeServes { controller.changeSetup { $0.homeServes = true } } }
            StudioChip("Them", on: !homeServes) { if homeServes { controller.changeSetup { $0.homeServes = false } } }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(homeServes ? "We serve" : "They serve")
    }
}

/// The zone controls in Simple: a style and whose colour; the full strip is in Advanced.
struct SimpleZoneStrip: View {
    @Bindable var controller: StudioController

    var body: some View {
        let style = controller.stripStyle
        HStack(spacing: 8) {
            Text(controller.selectedZone == nil ? "Draw a zone" : "Zone").font(.themed(13, .semibold))
                .foregroundStyle(Tokens.textSecondary.color)
            StudioChip("Lines", on: style.pattern == .diagonal) { controller.updateStyle { $0.pattern = .diagonal } }
            StudioChip("Dots", on: style.pattern == .dots) { controller.updateStyle { $0.pattern = .dots } }
            StudioChip("Glow", on: style.pattern == .glowFill) { controller.updateStyle { $0.pattern = .glowFill } }
            StudioChip("Outline", on: style.pattern == .outline) { controller.updateStyle { $0.pattern = .outline } }
            Divider().frame(height: 32).overlay(Tokens.hairline.color)
            StudioChip("Ours", on: style.tint == .pink) { controller.updateStyle { $0.tint = .pink } }
            StudioChip("Theirs", on: style.tint == .cyan) { controller.updateStyle { $0.tint = .cyan } }
            if controller.selectedZone != nil {
                Divider().frame(height: 32).overlay(Tokens.hairline.color)
                StudioChip("Delete", symbol: "trash") { controller.deleteSelection() }
            }
        }
        .studioPanel(emphasis: true)
    }
}
