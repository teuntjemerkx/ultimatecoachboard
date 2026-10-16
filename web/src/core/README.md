# Core (TypeScript)

A faithful port of the Swift package `CoachBoardCore` (same names, same algorithms, same tests) so the web app
runs the same rules, physics and reconstruction. Areas:

- `match/`: court frames, rules (overlap engine), rotation templates and team systems, match state, live store, skill
  coding, match log.
- `spatial/`: 3D maths, skeleton and posture library, avatar mesh, cameras, ball flight, line of sight, POV analysis.
- `zones/`: zones and smart geometry, tactical scenes, timeline, ball plan, the rally autopilot.
- `video/`: calibration, tracking, pose fitting, ball reconstruction, clean plate, video scenes.

Resources (`resources/`) are copies of the Swift package's JSON files.
