import SwiftUI
import CoachBoardCore

/// Substitution (Screen 3): after a long-press on a home token, a bench chip swaps that player out.
struct BenchStrip: View {
    let controller: LiveController

    var body: some View {
        HStack(spacing: 8) {
            Text("SUB FOR \(controller.subTargetLabel ?? "")").font(.sectionLabel).foregroundStyle(Tokens.accent.color)
            if controller.benchChips.isEmpty {
                Text("No bench players \u{2014} add them to the roster").font(.system(size: 13))
                    .foregroundStyle(Tokens.textSecondary.color)
            }
            ForEach(controller.benchChips, id: \.id) { chip in
                Button { controller.substitute(with: chip.id) } label: {
                    Text(chip.label)
                        .font(.themed(20, .bold).monospacedDigit())
                        .frame(minWidth: Tokens.targetLivePrimary, minHeight: Tokens.targetLivePrimary)
                        .background(Tokens.canvasBase.color, in: RoundedRectangle(cornerRadius: Tokens.cornerRadius))
                        .overlay(RoundedRectangle(cornerRadius: Tokens.cornerRadius).stroke(Tokens.accent.withAlpha(0.6).color))
                }
                .foregroundStyle(Tokens.text.color)
                .accessibilityLabel("Substitute number \(chip.label)")
            }
        }
        .padding(10)
        .background(Tokens.canvasRaised.color, in: RoundedRectangle(cornerRadius: Tokens.cornerRadius))
        .overlay(RoundedRectangle(cornerRadius: Tokens.cornerRadius).stroke(Tokens.accent.color, lineWidth: 1.5))
    }
}

/// RING tool (Screen 3): load any rotation and phase of the template, with its routes, as a read-only preview.
struct RingPanel: View {
    @Bindable var controller: LiveController
    @State private var phase = "receive"

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("TEMPLATE \u{00B7} \(controller.state.template.system)").font(.sectionLabel)
                .foregroundStyle(Tokens.textSecondary.color)
            Picker("Phase", selection: $phase) {
                Text("Receive").tag("receive")
                Text("Serve").tag("serve")
            }
            .pickerStyle(.segmented)
            HStack(spacing: 6) {
                ForEach(1...6, id: \.self) { r in
                    let on = controller.preview?.rotation == r
                    Button("R\(r)") { controller.showPreview(rotation: r, phase: phase) }
                        .font(.themed(14, .bold))
                        .frame(width: 40, height: Tokens.targetStandard)
                        .background(on ? Tokens.accent.color : Tokens.canvasBase.color, in: RoundedRectangle(cornerRadius: Tokens.radiusSmall))
                        .foregroundStyle(on ? Tokens.canvasBase.color : Tokens.text.color)
                }
            }
            HStack {
                Button("Reset tokens") {
                    controller.endPreview()
                    controller.resetTokens()
                }
                Spacer()
                if controller.preview != nil {
                    Button("Back to live") { controller.endPreview() }.fontWeight(.semibold)
                }
            }
            .font(.system(size: 14))
        }
        .padding(12)
        .frame(width: 300)
        .background(Tokens.canvasRaised.color, in: RoundedRectangle(cornerRadius: Tokens.cornerRadius))
        .overlay(RoundedRectangle(cornerRadius: Tokens.cornerRadius).stroke(Tokens.accent.withAlpha(0.6).color))
        .onChange(of: phase) { _, newPhase in
            if let r = controller.preview?.rotation { controller.showPreview(rotation: r, phase: newPhase) }
        }
    }
}

/// Advanced Mode (Screen 4): the non-modal skill-coding pad placed next to the tapped token. The predicted skill
/// is preselected, so the usual case is one tap on a grade.
struct SkillPadOverlay: View {
    @Bindable var controller: LiveController
    @State private var skill: Skill = .serve

    var body: some View {
        if let pad = controller.skillPad {
            let g = controller.geometry
            let p = g.toView(pad.point, side: pad.side)
            let width: CGFloat = 430, height: CGFloat = 156
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

struct SkillPad: View {
    let controller: LiveController
    let pad: LiveController.SkillPadTarget
    @Binding var skill: Skill

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("#\(controller.labels[pad.player] ?? "?") \u{00B7} \(skill.name.uppercased())")
                    .font(.sectionLabel)
                    .foregroundStyle(Tokens.team(pad.side).color)
                Spacer()
                Button { controller.closeSkillPad() } label: {
                    Image(systemName: "xmark").frame(width: 32, height: 32)
                }
                .foregroundStyle(Tokens.textSecondary.color)
                .accessibilityLabel("Close skill pad")
            }
            HStack(spacing: 6) {
                ForEach(Skill.allCases, id: \.self) { s in
                    Button(s.rawValue) { skill = s }
                        .font(.themed(15, .bold))
                        .frame(width: 52, height: 36)
                        .background(s == skill ? Tokens.text.color : Tokens.canvasBase.color, in: RoundedRectangle(cornerRadius: Tokens.radiusSmall))
                        .foregroundStyle(s == skill ? Tokens.canvasBase.color : Tokens.text.color)
                        .accessibilityLabel(s.name)
                }
            }
            HStack(spacing: 6) {
                ForEach(SkillGrade.allCases, id: \.self) { grade in
                    Button { controller.code(skill: skill, grade: grade) } label: {
                        Text(skill.rawValue + grade.symbol)
                            .font(.themed(20, .heavy))
                            .frame(width: 64, height: Tokens.targetLivePrimary)
                            .background(Tokens.canvasBase.color, in: RoundedRectangle(cornerRadius: Tokens.cornerRadius))
                            .overlay(RoundedRectangle(cornerRadius: Tokens.cornerRadius).stroke(gradeColor(grade).color, lineWidth: 1.5))
                    }
                    .foregroundStyle(Tokens.text.color)
                    .accessibilityLabel("\(skill.name) \(grade.symbol)")
                }
            }
        }
        .padding(12)
        .background(Tokens.canvasRaised.withAlpha(0.97).color, in: RoundedRectangle(cornerRadius: Tokens.cornerRadius))
        .overlay(RoundedRectangle(cornerRadius: Tokens.cornerRadius).stroke(Tokens.accent.withAlpha(0.7).color))
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

/// Advanced Mode's live stat strip (Screen 4): side-out rate per home rotation over its last 10 rallies;
/// a tap shows side-out and break rates with their counts.
struct LiveStatStrip: View {
    let controller: LiveController
    @AppStorage("gripRight") private var gripRight = true
    @State private var detail: Int?

    var body: some View {
        HStack(spacing: 0) {
            Text("SIDE-OUT, LAST 10").font(.themed(9, .semibold))
                .foregroundStyle(Tokens.textSecondary.color)
                .padding(.horizontal, 10)
            ForEach(controller.rotationCells) { c in
                Button { detail = c.id } label: {
                    HStack(spacing: 6) {
                        Text("R\(c.id)").font(.sectionLabel)
                            .foregroundStyle(c.id == controller.homeRotation ? Tokens.home.color : Tokens.textSecondary.color)
                        Text(Self.percent(c.sideOutWon, c.sideOutTotal)).font(.dataMono)
                    }
                    .frame(maxWidth: .infinity, minHeight: Tokens.statusHeight)
                }
                .foregroundStyle(Tokens.text.color)
                .popover(isPresented: Binding(get: { detail == c.id }, set: { if !$0 { detail = nil } })) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("R\(c.id) \u{00B7} last 10 rallies").font(.sectionLabel)
                        Text("Side-out: \(c.sideOutWon) of \(c.sideOutTotal)  (\(Self.percent(c.sideOutWon, c.sideOutTotal)))")
                        Text("Break: \(c.breakWon) of \(c.breakTotal)  (\(Self.percent(c.breakWon, c.breakTotal)))")
                    }
                    .font(.system(size: 15))
                    .padding(16)
                }
            }
        }
        .padding(gripRight ? .trailing : .leading, 330)     // stays clear of the Thumb Cluster
        .frame(height: Tokens.statusHeight)
        .background(Tokens.canvasRaised.color)
        .overlay(alignment: .top) { Rectangle().fill(Tokens.hairline.color).frame(height: 1) }
    }

    static func percent(_ won: Int, _ total: Int) -> String {
        total == 0 ? "\u{2013}" : "\(Int((100 * Double(won) / Double(total)).rounded()))%"
    }
}
