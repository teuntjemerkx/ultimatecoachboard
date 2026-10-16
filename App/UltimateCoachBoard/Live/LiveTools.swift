import SwiftUI
import CoachBoardCore

/// Plain words for the Simple coach level: roles, players and grades without scouting shorthand.
enum PlainWords {
    /// A template role code in words: "OH1" becomes "Outside 1", "S" "Setter", "A" "Player A".
    static func role(_ code: String) -> String {
        let words: [(prefix: String, word: String)] = [("OPP", "Opposite"), ("OH", "Outside"), ("MB", "Middle"),
                                                        ("S", "Setter"), ("L", "Libero")]
        for w in words where code.hasPrefix(w.prefix) {
            let rest = code.dropFirst(w.prefix.count)
            return rest.isEmpty ? w.word : "\(w.word) \(rest)"
        }
        return code.count == 1 ? "Player \(code)" : code
    }

    /// A player on screen: "#8" for a jersey number, otherwise the role (in words in Simple).
    static func player(_ label: String?, advanced: Bool) -> String {
        guard let label else { return "?" }
        if Int(label) != nil { return "#\(label)" }
        return advanced ? label : role(label)
    }

    /// The grade of a coded touch in one word, best to worst.
    static func grade(_ g: SkillGrade) -> String {
        switch g {
        case .perfect: return "Perfect"
        case .positive: return "Good"
        case .fair: return "OK"
        case .negative: return "Weak"
        case .poor: return "Poor"
        case .error: return "Error"
        }
    }
}

/// Substitution (Screen 3): after a long-press on a home token, a bench chip swaps that player out.
struct BenchStrip: View {
    let controller: LiveController

    var body: some View {
        let advanced = ThemeStore.shared.advanced
        let who = controller.subTargetLabel ?? ""
        HStack(spacing: 10) {
            Text(advanced ? "Sub for \(who)" : "Swap \(who) with")
                .font(.themed(17, .bold)).foregroundStyle(Tokens.text.color)
                .padding(.horizontal, 4)
            if controller.benchChips.isEmpty {
                Text("No one on the bench. Add players to your team first.")
                    .font(.themed(16, .regular))
                    .foregroundStyle(Tokens.textSecondary.color)
            }
            ForEach(controller.benchChips, id: \.id) { chip in
                Button { controller.substitute(with: chip.id) } label: {
                    Text(chip.label)
                        .font(.themed(22, .bold).monospacedDigit())
                        .frame(minWidth: Tokens.targetLivePrimary, minHeight: Tokens.targetLivePrimary)
                        .background(Tokens.canvasBase.color, in: RoundedRectangle(cornerRadius: Tokens.cornerRadius))
                        .overlay(RoundedRectangle(cornerRadius: Tokens.cornerRadius).stroke(Tokens.accent.withAlpha(0.6).color))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(Tokens.text.color)
                .accessibilityLabel("Bring on number \(chip.label)")
            }
        }
        .padding(10)
        .background(Tokens.canvasRaised.color, in: RoundedRectangle(cornerRadius: Tokens.radiusCard))
        .overlay(RoundedRectangle(cornerRadius: Tokens.radiusCard).stroke(Tokens.accent.color, lineWidth: 1.5))
    }
}

/// RING tool (Screen 3): load any rotation and phase of the template, with its routes, as a read-only preview.
struct RingPanel: View {
    @Bindable var controller: LiveController
    @State private var phase = "receive"

    var body: some View {
        let advanced = ThemeStore.shared.advanced
        VStack(alignment: .leading, spacing: 12) {
            Text(advanced ? "Template \u{00B7} \(controller.state.template.system)" : "Show a rotation")
                .font(.themed(17, .bold))
                .foregroundStyle(Tokens.text.color)
            ChoiceBar(options: [(value: "receive", title: advanced ? "Receive" : "We receive"),
                                (value: "serve", title: advanced ? "Serve" : "We serve")],
                      selection: $phase)
            HStack(spacing: 6) {
                ForEach(1...6, id: \.self) { r in
                    let on = controller.preview?.rotation == r
                    Button { controller.showPreview(rotation: r, phase: phase) } label: {
                        Text(advanced ? "R\(r)" : "\(r)")
                            .font(.themed(17, .bold))
                            .frame(maxWidth: .infinity, minHeight: Tokens.targetStandard)
                            .background(on ? Tokens.accent.color : Tokens.canvasBase.color, in: RoundedRectangle(cornerRadius: Tokens.radiusSmall))
                            .overlay(RoundedRectangle(cornerRadius: Tokens.radiusSmall).stroke(Tokens.hairline.color))
                            .foregroundStyle(on ? Tokens.onAccent.color : Tokens.text.color)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Rotation \(r)")
                    .accessibilityAddTraits(on ? .isSelected : [])
                }
            }
            if !advanced {
                Text("Tap a number to see where everyone stands.")
                    .font(.themed(15, .regular))
                    .foregroundStyle(Tokens.textSecondary.color)
            }
            HStack(spacing: 8) {
                Button("Reset positions") {
                    controller.endPreview()
                    controller.resetTokens()
                }
                .buttonStyle(CoachButtonStyle(kind: .quiet, minHeight: Tokens.targetStandard))
                Spacer(minLength: 0)
                if controller.preview != nil {
                    Button("Back to live") { controller.endPreview() }
                        .buttonStyle(CoachButtonStyle(kind: .secondary, minHeight: Tokens.targetStandard))
                }
            }
        }
        .padding(14)
        .frame(width: 340)
        .background(Tokens.canvasRaised.color, in: RoundedRectangle(cornerRadius: Tokens.radiusCard))
        .overlay(RoundedRectangle(cornerRadius: Tokens.radiusCard).stroke(Tokens.accent.withAlpha(0.6).color))
        .onChange(of: phase) { _, newPhase in
            if let r = controller.preview?.rotation { controller.showPreview(rotation: r, phase: newPhase) }
        }
    }
}

/// Detailed live mode (Screen 4): the non-modal skill-coding pad placed next to the tapped token. The predicted
/// skill is preselected, so the usual case is one tap on a grade.
struct SkillPadOverlay: View {
    @Bindable var controller: LiveController
    @State private var skill: Skill = .serve

    var body: some View {
        if let pad = controller.skillPad {
            let g = controller.geometry
            let p = g.toView(pad.point, side: pad.side)
            let width: CGFloat = 450, height: CGFloat = 200
            let x = min(max(p.x, width / 2 + 8), max(g.size.width - width / 2 - 8, width / 2 + 8))
            let below = p.y + 44 + height < g.size.height
            let y = below ? p.y + 44 + height / 2 : max(p.y - 44 - height / 2, height / 2)
            SkillPad(controller: controller, pad: pad, skill: $skill)
                .frame(width: width)
                .position(x: x, y: y)
                .onAppear { skill = pad.predicted }
                .onChange(of: pad) { _, newPad in skill = newPad.predicted }
        }
    }
}

/// Skills in the scouting letters (Advanced) or in words (Simple), then the six grades.
struct SkillPad: View {
    let controller: LiveController
    let pad: LiveController.SkillPadTarget
    @Binding var skill: Skill

    var body: some View {
        let advanced = ThemeStore.shared.advanced
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("\(PlainWords.player(controller.labels[pad.player], advanced: advanced)) \u{00B7} \(skill.name)")
                    .font(.themed(17, .bold))
                    .foregroundStyle(Tokens.team(pad.side).color)
                Spacer()
                Button { controller.closeSkillPad() } label: {
                    Image(systemName: "xmark")
                        .font(.themed(17, .bold))
                        .frame(width: Tokens.targetStandard, height: Tokens.targetStandard)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(Tokens.textSecondary.color)
                .accessibilityLabel("Close")
            }
            if advanced {
                HStack(spacing: 6) {
                    ForEach(Skill.allCases, id: \.self) { s in skillButton(s, title: s.rawValue) }
                }
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(Skill.allCases, id: \.self) { s in skillButton(s, title: s.name) }
                    }
                }
            }
            HStack(spacing: 6) {
                ForEach(SkillGrade.allCases, id: \.self) { grade in
                    Button { controller.code(skill: skill, grade: grade) } label: {
                        VStack(spacing: 2) {
                            Text(advanced ? skill.rawValue + grade.symbol : grade.symbol)
                                .font(.themed(22, .heavy))
                            if !advanced {
                                Text(PlainWords.grade(grade))
                                    .font(.themed(13, .semibold))
                                    .lineLimit(1)
                                    .minimumScaleFactor(0.7)
                            }
                        }
                        .frame(maxWidth: .infinity, minHeight: advanced ? Tokens.targetLivePrimary : 68)
                        .background(Tokens.canvasBase.color, in: RoundedRectangle(cornerRadius: Tokens.cornerRadius))
                        .overlay(RoundedRectangle(cornerRadius: Tokens.cornerRadius).stroke(gradeColor(grade).color, lineWidth: 1.5))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Tokens.text.color)
                    .accessibilityLabel("\(skill.name), \(PlainWords.grade(grade))")
                }
            }
        }
        .padding(12)
        .background(Tokens.canvasRaised.withAlpha(0.97).color, in: RoundedRectangle(cornerRadius: Tokens.radiusCard))
        .overlay(RoundedRectangle(cornerRadius: Tokens.radiusCard).stroke(Tokens.accent.withAlpha(0.7).color))
    }

    private func skillButton(_ s: Skill, title: String) -> some View {
        let on = s == skill
        return Button { skill = s } label: {
            Text(title)
                .font(.themed(15, .bold))
                .lineLimit(1)
                .padding(.horizontal, 10)
                .frame(maxWidth: ThemeStore.shared.advanced ? .infinity : nil, minHeight: Tokens.targetStandard)
                .background(on ? Tokens.text.color : Tokens.canvasBase.color, in: RoundedRectangle(cornerRadius: Tokens.radiusSmall))
                .foregroundStyle(on ? Tokens.canvasBase.color : Tokens.text.color)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(s.name)
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    private func gradeColor(_ g: SkillGrade) -> RGBA {
        switch g {
        case .perfect, .positive: return Tokens.accent
        case .fair: return Tokens.text.withAlpha(0.5)
        case .negative, .poor: return Tokens.text.withAlpha(0.3)
        case .error: return Tokens.fault
        }
    }
}

/// Detailed live mode's stat strip (Screen 4): side-out rate per home rotation over its last 10 rallies;
/// a tap shows side-out and break-point rates with their counts.
struct LiveStatStrip: View {
    let controller: LiveController
    @AppStorage("gripRight") private var gripRight = true
    @State private var detail: Int?

    var body: some View {
        let advanced = ThemeStore.shared.advanced
        HStack(spacing: 0) {
            Text(advanced ? "Side-out, last 10" : "Side-out\nlast 10 rallies")
                .font(.themed(13, .semibold))
                .lineLimit(2)
                .foregroundStyle(Tokens.textSecondary.color)
                .padding(.horizontal, 10)
                .fixedSize()
            ForEach(controller.rotationCells) { c in
                let current = c.id == controller.homeRotation
                Button { detail = c.id } label: {
                    Group {
                        if advanced {
                            HStack(spacing: 6) {
                                Text("R\(c.id)").font(.themed(15, .bold))
                                    .foregroundStyle(current ? Tokens.home.color : Tokens.textSecondary.color)
                                Text(Self.percent(c.sideOutWon, c.sideOutTotal)).font(.dataMono)
                            }
                        } else {
                            VStack(spacing: 0) {
                                Text("Rotation \(c.id)").font(.themed(13, .semibold))
                                    .foregroundStyle(current ? Tokens.home.color : Tokens.textSecondary.color)
                                Text(Self.percent(c.sideOutWon, c.sideOutTotal)).font(.themed(17, .bold).monospacedDigit())
                            }
                        }
                    }
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                    .frame(maxWidth: .infinity, minHeight: Tokens.statusHeight)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(Tokens.text.color)
                .accessibilityLabel("Rotation \(c.id): side-out \(Self.percent(c.sideOutWon, c.sideOutTotal))")
                .popover(isPresented: Binding(get: { detail == c.id }, set: { if !$0 { detail = nil } })) {
                    VStack(alignment: .leading, spacing: 8) {
                        if advanced {
                            Text("R\(c.id) \u{00B7} last 10 rallies").font(.themed(15, .bold))
                            Text("Side-out: \(c.sideOutWon) of \(c.sideOutTotal)  (\(Self.percent(c.sideOutWon, c.sideOutTotal)))")
                            Text("Break: \(c.breakWon) of \(c.breakTotal)  (\(Self.percent(c.breakWon, c.breakTotal)))")
                        } else {
                            Text("Rotation \(c.id), last 10 rallies").font(.themed(17, .bold))
                            Text("Side-out (won on their serve): \(c.sideOutWon) of \(c.sideOutTotal)")
                            Text("Break point (won on our serve): \(c.breakWon) of \(c.breakTotal)")
                        }
                    }
                    .font(.themed(17, .regular))
                    .padding(16)
                }
            }
        }
        .padding(gripRight ? .trailing : .leading, LiveLayout.cluster)     // stays clear of the Thumb Cluster
        .frame(height: Tokens.statusHeight)
        .background(Tokens.canvasRaised.color)
        .overlay(alignment: .top) { Rectangle().fill(Tokens.hairline.color).frame(height: 1) }
    }

    static func percent(_ won: Int, _ total: Int) -> String {
        total == 0 ? "\u{2013}" : "\(Int((100 * Double(won) / Double(total)).rounded()))%"
    }
}
