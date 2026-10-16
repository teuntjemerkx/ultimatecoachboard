# The Ultimate Coach Board — Phase 1 code

Phase 1 ("Sideline Core") of the blueprint *The Ultimate Coach Board — Master Engineering & Design Blueprint*:
the domain core as a tested Swift package, and an iPad app slice that runs a live match in Solo-Coach Mode.

## Status — read this first

- **`CoachBoardCore` builds and passes its tests.** Swift 6.1 on Linux (the `swift:6.1-noble` image): clean build
  with no warnings, 31 of 31 tests passing.
- **The iPad app has not been compiled yet.** It needs the iOS SDK, so it only builds on macOS. The CI workflow
  (`.github/workflows/ci.yml`) builds it for the iOS Simulator on a macOS runner with Xcode 26; until that run is
  green, expect a short round of compile fixes. The Metal shaders have only been reviewed by reading.
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
    Templates/             rotation templates (JSON), validation, 6-2 mapping, route timing
    Scouting/              Micro-Scouting two-tap state machine, lanes, grid cells, attribution
    Geometry/              Smart Geometry recognizer (corner-gated version of Appendix D5)
    Journal/               append-only match journal: CRC-32C records, group commit, torn-tail recovery
    Store/                 LiveState: the pure reducer behind the Live screens, exact undo, journal replay
    Resources/             fivb-senior.json and the verified templates (generated, do not hand-edit)
  Tests/CoachBoardCoreTests/
App/                       iPad app (XcodeGen project spec)
  UltimateCoachBoard/
    Board/                 Metal 2D board renderer + shaders, gestures, view-to-court mapping
    Live/                  Live controller, Live screen, Point Wheel, Panic, Set Break, rotation correction
    Screens/               Launcher, Match Setup
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
| 5-1, 4-2, 6-2, youth W templates (Appendix A) | `Resources/Templates`, `TemplateLibrary` | Receive and serve formations; 6-2 derived from 5-1 |
| Route timing validator (2.6) | `Templates/RouteTiming.swift` | Implemented, tested; not yet drawn on the board |
| Micro-Scouting (2.9) | `Scouting/MicroScout.swift`, board taps | Implemented with attribution and summaries |
| Panic Time-Out (2.8) | `Live/LiveView.swift` `PanicOverlay` | Countdown, ink, flip for players, attacks toggle, clear |
| Match journal and crash recovery (B3) | `Journal/Journal.swift`, `Services/JournalPipe.swift` | Implemented; launcher offers "Resume unfinished match" |
| Exact undo / redo (2.2) | `Store/LiveStore.swift` | Implemented, tested |
| Smart Geometry recognizer (3.5.3) | `Geometry/SmartGeometry.swift` | Implemented and tested; the Zone tool UI arrives in Phase 2 |
| 2D Metal board (3.2) | `Board/` | Court, zone grid, SDF tokens, glyph-atlas numbers, vectors, tethers, ink, hatched envelope |

Not yet in this slice (rest of Phase 1 per Section 6.9): SwiftData roster and match store (the slice saves the
last setup as JSON), Match Log screen, skill-coding pad (Advanced Mode), Desk Link, MSDF glyphs, the EDR/P3 colour
pipeline and Sideline Boost. Phase 2 starts with the 3D renderer and the Zone & Hatching engine.
