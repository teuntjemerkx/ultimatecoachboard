# Handoff: where the project stands

Read this first when you continue the project in a new session or under another account.

The owner speaks Dutch: always answer in Dutch. App UI text, code, comments and commits are in English.

## What this repo holds

- `CoachBoardCore/` is the Swift package with all the logic: match, rotations, zones, 3D and video. It has 132 tests. Run them without a Mac via Docker:
  ```
  docker run --rm --network none -v "$PWD/CoachBoardCore:/pkg" -w /pkg swift:6.1-noble swift test
  ```
- `App/` is the native iPad app (SwiftUI + Metal). It builds in GitHub Actions only (`.github/workflows/ci.yml`, macOS runner). Screenshots land on the `ci-screenshots` branch.
  - The owner does **not** want a paid App Store app.
  - The native app is complete through phase 2, but it is no longer the focus.
- `web/` is **the product the owner uses**: a free, installable web app (PWA) for the iPad.
  - Stack: Vite + React + TypeScript (strict), Three.js, zustand, IndexedDB, and MediaPipe for video.
  - Hosting: Vercel project `coach-board`, connected to GitHub with root directory `web`. Every push to `main` deploys to production at https://coach-board-teuntjemerkx-8584s-projects.vercel.app (public; previews need a Vercel login).
  - To install, open the link in Safari, then Share → Add to Home Screen.
  - All the owner's data stays on the iPad (IndexedDB). Settings → Backup makes a JSON file.

## Web app: done

- Home, Settings, Players and Season, with the "Locker room" theme by default: white and navy, a blue LED accent, Barlow Condensed type. Three more themes are available.
- Matches:
  - Setup, the live court with one-tap points, undo and swap sides.
  - Set break with side-out by rotation and the next start rotation.
  - Match log.
  - Saved after every point as the binary journal (`web/src/app/match/session.ts`).
- Core ported from Swift to TypeScript with Vitest tests (119 pass):
  - `web/src/core/match` (match domain)
  - `web/src/core/spatial` (3D math, skeleton, avatar mesh, postures, ball flight, line of sight, POV)
  - `web/src/core/zones` (zones, tactical scene, timeline, ball plan, rally autopilot)
- `web/src/app/video/detect.ts`: two-stage MediaPipe detection, tested on real broadcast frames. The models are downloaded at build time by `web/scripts/fetch-models.mjs`. Not wired to a screen yet.
- `web/src/app/three/Board3D.ts` and `Court3DView.tsx`: Three.js court, net, orbit camera, and fly-to eye view. Not wired to a screen yet.

## Web app: in progress, the Studio (task 1)

Route `{ name: "studio" }` in `web/src/app/store/nav.ts`. It still shows "Coming next" in `App.tsx`.

**Written:**
- `web/src/app/studio/studio.ts`: zustand store around `SceneEditor`.
  - Boards are saved in the IndexedDB `boards` store.
  - Lineup and setup changes, rotate, play a rally (autopilot), timeline playback (1.1 s per phase).
  - Move a player with placement snapping, ink, zones built from a stroke, zone style, undo/redo, rename.
  - Eye view state (`pov`, `povYaw`, `povPitch`) and sight lines (`gaze`).
- `web/src/app/studio/Board2D.tsx`: the 2D board.
  - Zones drawn with SVG patterns, ink, the ball, and tokens.
  - Gestures: drag to move a player or zone, tap to select, pen and zone tools.
- Zone tint colours `zoneA` and `zoneB` added to every theme. `courtView()` is exported from `ui/Court2D.tsx`.

**Still to do:**
1. `web/src/app/three/Players3D.ts`, the skinned avatars:
   - Use `new AvatarMesh(skeleton).buffers()`, cached per stature, with CPU dual-quaternion skinning per frame (`skeleton.skin(joints)` gives a `DualQuat` per joint).
   - Vertex colours per `AvatarMaterial`; the jersey takes the team colour (`--c-home` / `--c-opponent`).
   - A number sprite above the head, the ball as a sphere (r 0.105), zones as `ShapeGeometry` on the floor, and ink as lines.
   - Poses come from `posedPlayers(frame)`. Hide the eye-view player's own avatar.
2. `web/src/app/studio/Board3D` wrapper. Use `Court3DView`:
   - One finger: drag a player, or look around when in eye view.
   - Tap: select.
   - Eye view: `board.flyTo(() => pose)`, where the pose is `skeleton.povPose(joints, aspect, {yaw, pitch})`. Its `eye`, `rotation` (x, y, z, w) and `fovY` (radians) map onto the Three.js camera.
3. `web/src/app/studio/Studio.tsx`. Mirror the native `App/UltimateCoachBoard/Studio/StudioView.swift` and `StudioControls.swift`:
   - Tool rail: Move / Draw / Zone, Undo / Redo, Delete, Erase.
   - Top bar: title (tap to rename), 2D|3D, Boards list.
   - Lineup bar: system, rotation ‹ ›, Serve Us/Them, "Play a rally" Left/Middle/Right/Back row.
   - Timeline strip: play/pause, phase chips Serve/Pass/Set/Attack/Cover/Defence, Clear rally.
   - Eye view strip: "See what X sees" / "Leave eye view".
   - Simple zone strip: Lines/Dots/Glow/Outline, Ours/Theirs.
   - Advanced only: opponent system and rotation, sight lines.
   - Set `PlayerBodies.women` from settings, so net and statures follow women/men.
4. Route it in `App.tsx`, then check it in headless Chromium: Playwright with `executablePath: '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell'`.

## Web app: next, Video to 3D (task 2)

1. Port `CoachBoardCore/Sources/CoachBoardCore/Video/*.swift` (about 2,700 lines) and its tests (`VideoTests.swift`, `RealCalibrationTests.swift`) to `web/src/core/video/`. Reuse the spatial, zones and match ports.
2. Screens, built the same way as the native `VideoImportView` and `VideoWatchView`:
   - pick a clip (about 8 s, often filmed from behind one end line) and sample frames;
   - mark the 4 court corners;
   - run `detect.ts`;
   - build the clean plate and reconstruct;
   - store the result in the IndexedDB `videos` store;
   - watch it in 3D, tap a player to fly into their eyes, with the hall from the video as the environment (projective texture).

## Checks before pushing

```
cd web && npx tsc -b && npx vitest run && npm run build
```
Commit trailers used in this repo end with a `Co-Authored-By:` line and a `Claude-Session:` line.
