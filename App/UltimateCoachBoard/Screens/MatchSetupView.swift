import SwiftUI
import CoachBoardCore

/// Screen 2 (Phase 1 subset): names, jersey numbers in template order, starting rotations, first serve, mode, net height.
struct MatchSetupView: View {
    @State private var setup: MatchSetupData
    var onStart: (MatchSetupData) -> Void
    var onCancel: () -> Void

    init(initial: MatchSetupData, onStart: @escaping (MatchSetupData) -> Void, onCancel: @escaping () -> Void) {
        _setup = State(initialValue: initial)
        self.onStart = onStart
        self.onCancel = onCancel
    }

    private let roleNames = ["Setter", "Outside 1", "Middle 1", "Opposite", "Outside 2", "Middle 2"]

    var body: some View {
        NavigationStack {
            Form {
                Section("Teams") {
                    TextField("Our team", text: $setup.homeName)
                    TextField("Opponent", text: $setup.opponentName)
                }
                Section("Our lineup (5-1, outside follows setter)") {
                    ForEach(0..<6, id: \.self) { i in
                        numberRow(roleNames[i], value: Binding(get: { setup.homeNumbers[i] }, set: { setup.homeNumbers[i] = $0 }))
                    }
                    optionalNumberRow("Libero", value: $setup.homeLibero)
                    Picker("Starting rotation (setter in)", selection: $setup.homeStartRotation) {
                        ForEach(1...6, id: \.self) { Text("P\($0)").tag($0) }
                    }
                }
                Section("Opponent lineup (optional)") {
                    ForEach(0..<6, id: \.self) { i in
                        optionalNumberRow(roleNames[i], value: Binding(get: { setup.opponentNumbers[i] }, set: { setup.opponentNumbers[i] = $0 }))
                    }
                    optionalNumberRow("Libero", value: $setup.opponentLibero)
                    Picker("Starting rotation (setter in)", selection: $setup.opponentStartRotation) {
                        ForEach(1...6, id: \.self) { Text("P\($0)").tag($0) }
                    }
                }
                Section("Match") {
                    Picker("First serve", selection: $setup.firstServer) {
                        Text("Us").tag(Side.home)
                        Text("Them").tag(Side.opponent)
                    }
                    .pickerStyle(.segmented)
                    Toggle("Working alone today?", isOn: Binding(get: { setup.mode == .solo },
                                                                  set: { setup.mode = $0 ? .solo : .advanced }))
                    Picker("Net height", selection: $setup.netHeight) {
                        Text("2.43 m").tag(2.43)
                        Text("2.35 m").tag(2.35)
                        Text("2.24 m").tag(2.24)
                        Text("2.15 m").tag(2.15)
                        Text("2.10 m").tag(2.10)
                        Text("2.00 m").tag(2.00)
                    }
                }
                if let problem = validationProblem {
                    Section { Text(problem).foregroundStyle(Tokens.accentActive.color) }
                }
            }
            .navigationTitle("Match setup")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: onCancel) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Start") { onStart(setup) }.disabled(validationProblem != nil)
                }
            }
        }
    }

    /// Inline validation, never a dialog (Appendix C2).
    private var validationProblem: String? {
        let numbers = setup.homeNumbers
        if numbers.contains(where: { !(0...99).contains($0) }) { return "Jersey numbers run from 0 to 99." }
        if Set(numbers).count != 6 { return "Our six players need six different numbers." }
        if let libero = setup.homeLibero, numbers.contains(libero) { return "The libero cannot also be in the starting six." }
        let theirs = setup.opponentNumbers.compactMap { $0 }
        if Set(theirs).count != theirs.count { return "Opponent numbers must be different." }
        return nil
    }

    private func numberRow(_ title: String, value: Binding<Int>) -> some View {
        HStack {
            Text(title)
            Spacer()
            TextField("#", value: value, format: .number)
                .keyboardType(.numberPad)
                .multilineTextAlignment(.trailing)
                .frame(width: 80)
        }
    }

    private func optionalNumberRow(_ title: String, value: Binding<Int?>) -> some View {
        HStack {
            Text(title)
            Spacer()
            TextField("\u{2014}", value: value, format: .number)
                .keyboardType(.numberPad)
                .multilineTextAlignment(.trailing)
                .frame(width: 80)
        }
    }
}
