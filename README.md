# The Ultimate Coach Board — Phase 1 code

Phase 1 ("Sideline Core") of the blueprint *The Ultimate Coach Board — Master Engineering & Design Blueprint*:
the domain core as a tested Swift package, and an iPad app slice that runs a live match in Solo-Coach Mode.

## Status — read this first

- **Everything builds, and the core tests pass.** CI (`.github/workflows/ci.yml`) runs on every push:
  `CoachBoardCore` with Swift 6.1 on Linux and with Xcode 26 on macOS, and the iPad app built for the iOS
  Simulator on a macOS runner, shaders included. Compiler errors and test failures show up as annotations on the run.
- **Screenshots.** CI launches the app in the Simulator in demo mode
  (`-demoScreen launcher|setup|live|advanced|setbreak|log|studio|studio3d|pov|gallery`)
  and publishes the screenshots to the `ci-screenshots` branch on every push to `main`.
- **The app runs in the Simulator, not yet on a real iPad.** The CI screenshots show the screens rendering; touch
  gestures, Apple Pencil, the edge pulse in a loud hall and performance still need a session on a device.
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
| Route timing validator (2.6) | `Templates/RouteTiming.swift`, ROUTES on the rail | Tested; drawn live (dashed on time, solid with a LATE chip), re-timed while dragging |
| Micro-Scouting with aggregation (2.9) | `Scouting/MicroScout.swift`, board taps, Set Break fans | Implemented with attribution and summaries |
| Panic Time-Out (2.8) | `Live/LiveView.swift` `PanicOverlay` | Countdown, ink, flip for players, attacks toggle, clear |
| Substitutions (Screen 3) | long-press a token, then a bench chip | FIVB pairing rule, limit per set; libero and role follow the slot |
| RING tool (Screen 3) | rail, `Live/LiveTools.swift` | Any rotation and phase of the template as a read-only preview with routes |
| Advanced Mode (Screen 4) | `Store/SkillCoding.swift`, skill pad, stat strip | Skill codes S/R/E/A/B/D/F × #/+/!/−///= with a predicted skill, journalled and undoable; side-out/break strip; player stats in the Match Log |
| Roster with jersey-only quick add (Screens 18, 19) | `Roster/` | SwiftData teams and players, biometrics with range checks |
| Match Setup (Screen 2) | `Screens/MatchSetupView.swift` | Position slots fed by jersey chips, system, setter, inline validation |
| Set Break Summary (Screen 6) | `Live/SetBreakView.swift` | Side-out bars per rotation, attack fans, suggested start, next-set rotation |
| Match Log (Screen 7) | `MatchLog/` | Rows by set, filters, notes, read-only board per rally, journal export |
| Match journal and crash recovery (B3) | `Journal/Journal.swift`, `Services/JournalPipe.swift` | Implemented; launcher resumes unfinished matches |
| Exact undo / redo (2.2) | `Store/LiveStore.swift` | Implemented, tested |
| Smart Geometry recognizer (3.5.3) | `Geometry/SmartGeometry.swift` | Implemented and tested; the Zone tool UI arrives in Phase 2 |
| Zone & Hatching engine, 2D (3.5) | `Zones/`, `Board/Shaders.metal` `zoneFragment`, `Studio/` | Exact SDFs, Smart Geometry with court-aware snapping, tags with default styles, cross-hatch/diagonal/dots/glow/outline with anti-moiré; Studio (Screen 8, 2D) with the W3 strip, alternative chip, undo, scenes saved as JSON |
| 3D board (3.2, 5.2) | `Spatial/` (camera, skeleton, postures, skinning), `Board/Board3DRenderer.swift`, `Board/Shaders3D.metal` | One orbit camera for 2D and 3D with a dolly-zoom between them; 4x MSAA with depth; the floor pass shares the zone shader with 2D; net with mesh, tape, antennas and posts; 17-joint avatars sized by stature with dual-quaternion skinning and eight postures; zone walls and cylinders fading with height; labels above the heads. In the Studio: the 3D toggle, two-finger orbit and pinch, drawing and dragging on the floor through the touch ray, posture chips |
| POV, line of sight and field of view (5.1, 5.6, 5.7) | `Spatial/CameraPose.swift`, `Spatial/LineOfSight.swift`, `Spatial/POVAnalysis.swift`, Studio 3D | Head-locked POV at the skeleton's eye with free-look in the neck's range; reversed-Z infinite projection; fly-in on a raised Bezier arc; own head culled, own hands visible; capsule bodies and the opaque net parts as occluders, 16-ray visibility per target with "27% visible — blocked by #14 left forearm"; foveal, central and elliptical peripheral bands as cones in third person and rings in POV; tap players to add gaze targets |
| Avatars and the posture library (3.2, 5.2) | `Spatial/Skeleton.swift`, `Spatial/PostureLibrary.swift`, `Resources/Postures`, `Verification/postures` | Anatomically shaped skinned mesh (tapered limbs, oval trunk, hands, shoes, knee pads, hair) with jersey, shorts and skin materials and numbers on chest and back; 101 research postures over five positions from 376 references (studies, coaching manuals, technique analyses, player profiles; read through abstracts and summaries, see each file's sources), each value marked measured or estimated, anatomical angles to joint rotations, leg IK for the stance, slerp between postures. Preview offline with `Verification/preview_avatars.py` |
| Ball physics for manual contacts (4.7, 5.4) | `Spatial/BallFlight.swift`, `Zones/BallPlan.swift`, Studio ball strip | Gravity, quadratic drag and Magnus lift with RK4 at 1 ms (Appendix D constants); contacts per marker (float/jump serve, pass, quick/2nd tempo/high set, attack, free ball, dig) solved by shooting for a speed or an apex over the tape; net crossing checked against tape and antennas; the ball and its flights on the 2D and 3D boards; the ball is a gaze target |
| Zones and players through a rally (3.3, 3.5.7) | `Zones/SceneTimeline.swift`, `Studio/` timeline strip | Phase markers serve to defence; edits on a later marker become keyframes; centripetal Catmull-Rom paths by arc length with critically damped easing; zones interpolate per type (angles the short way), polygons resample to 64 points and align, type changes blend signed distances in the shader; posture slerp per joint; keyframed zone intensity; play, hold and clear |
| Templates: colour and layout (1.2, 1.4) | `Design/Theme.swift`, `Design/Tokens.swift`, Settings > Appearance, `docs/THEMES.md` | Five templates from research: Sports hall (recommended: light for lit halls, colour-blind-safe blue vs orange), Evening, TV broadcast, Whiteboard, Neon (the original); every screen, both boards and the avatars follow the template; the court stands upright in portrait; bigger score; new start screen |
| Easy placement and the rally autopilot | `Zones/SceneAutopilot.swift`, Studio lineup bar | One setup (both systems, both rotations, who serves) places all twelve players from the verified templates; the arrow moves to the next rotation as after a side-out, keeping players, labels and the libero swap; "Play a rally" (left, middle, right, back row) writes serve, pass, set, attack, block, cover and dig with postures and ball contacts as ordinary keyframes; players face the ball (or the server) unless turned by hand, shown in 2D by a dot on the ring; dropped players snap to formation spots and keep 0.5 m apart |
| Simple and Advanced | Settings > Coach level, every screen | Simple (the default) shows the essentials in plain words with large targets; Advanced adds the expert tools and compact labels: zone details, keyframes, postures, ball contacts, sight lines, the opponent's lineup, detailed stats |
| Video to 3D (4) | `Video/` (core: calibration, tracking, pose fitting, ball, plate, scene), `App/.../Video/` | Choose a clip, drag four dots onto the court corners (magnifier, the fitted court drawn over the video as a check), and the iPad rebuilds the rally with Apple's on-device Vision models: body pose and person boxes, ball trajectories, person segmentation. Camera from the corners (normalised DLT, focal length and pose from the homography, Levenberg-Marquardt), players tracked on the floor (Kalman, Hungarian, six per side), postures and facing by analysis-by-synthesis against the posture library with Viterbi smoothing, jumps, ball flights fitted by physics and anchored at hands and floor. The hall is the clip's own: a temporal median without the people (clean plate) projected through the video camera onto walls, floor and ceiling around the court, unseen parts filled from the mirror image. Plays back in the Studio from where it was filmed; eye view from any player. Limits: one fixed camera, no lens distortion model, ball depth only where anchored |
| 2D Metal board (3.2) | `Board/` | Court, zone grid, SDF tokens, signed-distance-field numbers, vectors, routes, tethers, ink, hatched envelope |
| Eyes-free feedback (1.6) | `Services/Haptics.swift`, `EdgePulse` | Edge pulse, optional click, Pencil Pro path-completed haptic |

Not yet in this slice: multi-channel (MSDF) glyphs (numbers use a single-channel distance field), Desk Link, the `.coachboard` package (the log exports the raw journal), the EDR/P3 colour
pipeline and Sideline Boost. Phase 2 so far: the Zone & Hatching engine, the 3D board in the Studio, the rally timeline and
manual-scene POV with gaze rays and field-of-view bands, and ball flight for manual contacts; next are the
Drill Architect and Smart Clip export.
