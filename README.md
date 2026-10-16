# The Ultimate Coach Board — Phase 1 code

Phase 1 ("Sideline Core") of the blueprint *The Ultimate Coach Board — Master Engineering & Design Blueprint*:
the domain core as a tested Swift package, and an iPad app slice that runs a live match in Solo-Coach Mode.

## Status — read this first

- **Everything builds, and the core tests pass.** CI (`.github/workflows/ci.yml`) runs on every push:
  `CoachBoardCore` with Swift 6.1 on Linux and with Xcode 26 on macOS, and the iPad app built for the iOS
  Simulator on a macOS runner, shaders included. Compiler errors and test failures show up as annotations on the run.
- **The app has not been run on a device yet.** Compiling proves types, SDK APIs and Metal syntax; rendering,
  gestures and feedback still need a session on a real iPad.
- **The logic is cross-checked.** The rules engine, the rotation templates, the timing model and the shape
  recognizer mirror executable Python references in `Verification/`, and the Swift unit tests assert the numbers
  those references produce (Appendix A and D of the blueprint).

## Layout

```
CoachBoardCore/            Swift package, no UI imports (blueprint Section 6.1 "Domain core")
  Sources/CoachBoardCore/
    Court/                 world and team-local frames, positions
    Rules/                 Rule & Court Profiles, FIVB overlap engine, Legal Envelope
    Rotation/              MatchState: rally outcomes, side-outs, libero automation, sets, substitutions
    Templates/             rotation templates (JSON), playing systems, lineup builder, validation, route timing
    Scouting/              Micro-Scouting two-tap state machine, lanes, grid cells, attribution
    Geometry/              Smart Geometry recognizer (corner-gated version of Appendix D5)
    Journal/               append-only match journal: CRC-32C records, group commit, torn-tail recovery
    Store/                 LiveState (pure reducer, exact undo, journal replay), rally history, Match Log rows
    Resources/             fivb-senior.json and the verified templates (generated, do not hand-edit)
  Tests/CoachBoardCoreTests/
App/                       iPad app (XcodeGen project spec)
  UltimateCoachBoard/
    Board/                 Metal 2D board renderer + shaders, gestures, view-to-court mapping, read-only board
    Live/                  Live controller, Live screen, Point Wheel, Panic, Set Break Summary, rotation correction
    MatchLog/              journal archive (recents, notes, Recently Deleted) and the Match Log screen
    Roster/                SwiftData teams and players, jersey-only quick add, player detail
    Screens/               Launcher with recents, Match Setup, Settings
    Services/              Feedback (edge pulse, optional click), ordered journal pipe (AsyncStream -> actor)
Verification/              Python references that generated and verified the numbers
```

## Build and test (on a Mac)

1. Core tests (Xcode 26 or a Swift 6 toolchain; Linux works too):
   ```
   cd CoachBoardCore
   swift test
   ```
   Without a local toolchain: `docker run --rm -v "$PWD/CoachBoardCore:/pkg" -w /pkg swift:6.1-noble swift test`
2. App:
   ```
   brew install xcodegen
   cd App
   xcodegen
   open UltimateCoachBoard.xcodeproj
   ```
   Set your Development Team in Signing & Capabilities, choose an iPad (iPadOS 26), Run.
3. Regenerate the template JSON after changing the atlas: `cd Verification && python3 gen_templates.py`
   (needs numpy). The Swift tests fail if a template's `expectedMinMargin` no longer matches the engine.

## What Phase 1 contains

| Blueprint item | Where | State |
| --- | --- | --- |
| Overlap engine, server exemption, inside-court rule (3.4) | `Rules/OverlapEngine.swift` | Implemented, tested against a raster reference |
| Legal Envelope (3.4.5) | `Rules/LegalEnvelope.swift`, drawn while dragging | Implemented, property-tested |
| Point Swipe rally logic, libero automation, set and match end (2.5) | `Rotation/MatchState.swift`, `Live/LiveView.swift` | Implemented, tested |
| 5-1 (both lineup orders), 6-2, 4-2, youth W (Appendix A) | `Resources/Templates`, `Templates/TeamSystem.swift` | Verified formations; 6-2 derived from the 5-1 by back-row setter |
| Route timing validator (2.6) | `Templates/RouteTiming.swift` | Implemented, tested; not yet drawn on the board |
| Micro-Scouting with aggregation (2.9) | `Scouting/MicroScout.swift`, board taps, Set Break fans | Implemented with attribution and summaries |
| Panic Time-Out (2.8) | `Live/LiveView.swift` `PanicOverlay` | Countdown, ink, flip for players, attacks toggle, clear |
| Roster with jersey-only quick add (Screens 18, 19) | `Roster/` | SwiftData teams and players, biometrics with range checks |
| Match Setup (Screen 2) | `Screens/MatchSetupView.swift` | Position slots fed by jersey chips, system, setter, inline validation |
| Set Break Summary (Screen 6) | `Live/SetBreakView.swift` | Side-out bars per rotation, attack fans, suggested start, next-set rotation |
| Match Log (Screen 7) | `MatchLog/` | Rows by set, filters, notes, read-only board per rally, journal export |
| Match journal and crash recovery (B3) | `Journal/Journal.swift`, `Services/JournalPipe.swift` | Implemented; launcher resumes unfinished matches |
| Exact undo / redo (2.2) | `Store/LiveStore.swift` | Implemented, tested |
| Smart Geometry recognizer (3.5.3) | `Geometry/SmartGeometry.swift` | Implemented and tested; the Zone tool UI arrives in Phase 2 |
| 2D Metal board (3.2) | `Board/` | Court, zone grid, SDF tokens, glyph-atlas numbers, vectors, tethers, ink, hatched envelope |
| Eyes-free feedback (1.6) | `Services/Haptics.swift`, `EdgePulse` | Edge pulse, optional click, Pencil Pro path-completed haptic |

Not yet in this slice: route timing drawn on the board, MSDF glyphs (numbers use a bitmap SDF atlas), the
skill-coding pad (Advanced Mode), Desk Link, the `.coachboard` package (the log exports the raw journal), the EDR/P3
colour pipeline and Sideline Boost. Phase 2 starts with the 3D renderer and the Zone & Hatching engine.
