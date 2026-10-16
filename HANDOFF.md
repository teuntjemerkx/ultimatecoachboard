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
- Match schedule (commit 05509c8): Settings → Match schedule takes the team's programme link (Nevobo export, webcal, any iCal/RSS). `web/api/schedule.ts` (a Vercel function, also mounted in the dev and preview servers) fetches it, because the feeds send no CORS headers. Home shows the next matches; tapping one opens New match with the opponent filled in. Code in `web/src/app/schedule/`.
- Studio (Screen 8), in `web/src/app/studio/`, opened from the Studio locker on Home:
  - `StudioScreen.tsx`: the screen, mirroring the native `StudioView.swift` and `StudioControls.swift`. It is not called `Studio.tsx` because macOS file systems ignore case, and that name clashes with the store `studio.ts`.
    - Tool rail: Move / Draw / Zone, Undo / Redo, Delete (selected zone), Erase (ink). Cmd-Z and Shift-Cmd-Z work too.
    - Top bar: title (tap to rename), 2D|3D, Reset view (3D), and Boards (new board from a system, rotation and serve or receive; open; delete with a second tap).
    - Dock under the board: the lineup bar (system, rotation ‹ ›, Serve Us/Them, Play a rally Left/Middle/Right/Back row), the timeline strip (play/pause, phase chips, Clear rally) and the eye-view strip.
    - Over the board: the zone strip (Lines/Dots/Glow/Outline, Ours/Theirs), the field rings in eye view, and the sight-line readouts.
    - Advanced adds: the opponent's system and rotation, Swap ends, the Cross fill, and sight lines.
    - `PlayerBodies.women` follows Settings, so the net and the statures follow women/men.
  - `studio.ts`: the zustand store around `SceneEditor`. Boards are saved in the IndexedDB `boards` store. Opening and creating boards run one after another, and a pending save is written before another board opens.
  - `Board2D.tsx`: the 2D board (zones as SVG patterns, ink, the ball, tokens; drag, tap, pen and zone tools).
  - `StudioBoard3D.tsx`: the 3D board wired to the store.
    - One finger on a player or zone drags it (with the same snapping as 2D). With Draw or Zone it draws through the touch ray. Elsewhere it turns the court; two fingers turn and pinch.
    - Entering 3D flies down from the 2D view to the bench (behind the home end line when the board stands upright); leaving flies back up first.
    - Eye view: `board.flyTo` follows `skeleton.povPose`, one finger looks around, and the player's own avatar hides once the camera is in their head.
  - `web/src/app/three/Players3D.ts`: the 3D scene content.
    - Avatars use `AvatarMesh` buffers cached per stature with CPU dual-quaternion skinning, in team colours (the libero in white).
    - Each player has a label above the head and a ring on the floor.
    - Also drawn: the ball and its shadow, zones (pattern textures) and ink as floor ribbons, sight lines, and a cylinder pick for taps.
  - `Court3DView.tsx` has an `onDispose` callback, so the Studio frees what it added before the board goes.
- Core ported from Swift to TypeScript with Vitest tests (126 pass):
  - `web/src/core/match` (match domain)
  - `web/src/core/spatial` (3D math, skeleton, avatar mesh, postures, ball flight, line of sight, POV)
  - `web/src/core/zones` (zones, tactical scene, timeline, ball plan, rally autopilot)
- `web/src/app/video/detect.ts`: two-stage MediaPipe detection, tested on real broadcast frames. The models are downloaded at build time by `web/scripts/fetch-models.mjs`. Not wired to a screen yet.

## Studio: not ported yet (Advanced extras of the native app)

- Keyframes per phase ("Animate by phase" for a static scene, "Hold here" / "Clear key", hide or show a zone per phase).
- The posture strip and the ball strip (contacts, aim the landing).
- The full zone strip: shape, density, angle, edge, and tags; the alternative-shape chip after a stroke.
- In eye view, a tap on another player adds or removes them as a gaze target (now it selects them for "Switch to").
- Zone walls and extrusions in 3D, and numbers printed on the jerseys.

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
On the owner's Mac, Node is in `~/.local/node` (linked from `~/.local/bin`). In the Claude desktop app, the browser pane starts the dev server from the `coach-board-studio` entry in `~/.claude/launch.json` (Vite on port 5174).
Commit trailers used in this repo end with a `Co-Authored-By:` line and a `Claude-Session:` line.
