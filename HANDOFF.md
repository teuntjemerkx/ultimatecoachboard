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
    - Dock under the board (in 3D it floats over the board, and a camera view offset centres the court above it): the selected player (name or shirt number; in 3D the eye view), the lineup bar (system, rotation ‹ ›, Serve Us/Them, Play a rally Left/Middle/Right/Back row) and the timeline strip (play/pause, phase chips, Clear rally).
    - Over the board: the zone strip (Lines/Dots/Glow/Outline, Ours/Theirs), the "Free shape?"-style alternative chip after an uncertain zone, the field rings in eye view, and the sight-line readouts (on in eye view; a tap on another player adds or removes them as a target).
    - Advanced adds:
      - the opponent's system and rotation, Swap ends, Snap on or off, and sight lines outside the eye view;
      - keyframes per phase: "Animate by phase" for a static board, a dot on each marker where the selection has a key, "Hold here" / "Clear key", hide or show a zone per phase, and "Static";
      - the body strip in 3D (Auto plus the 24 postures, keyed at the marker) and the ball strip (who plays it and how, No ball, Aim the landing, the flight readout);
      - the full zone strip: shape (refits a selected zone), fill, density, angle, edge, Ours/Theirs and the tag (No-fly, Serve target and Tip alert get walls in 3D).
    - `PlayerBodies.women` follows Settings, so the net and the statures follow women/men.
  - `studio.ts`: the zustand store around `SceneEditor`. Boards are saved in the IndexedDB `boards` store. Opening and creating boards run one after another, and a pending save is written before another board opens.
  - `Board2D.tsx`: the 2D board (zones as SVG patterns, ink, the ball and its flights, snap highlights, tokens; drag, tap, pen and zone tools).
  - `StudioBoard3D.tsx`: the 3D board wired to the store.
    - One finger on a player or zone drags it (with the same snapping as 2D). With Draw or Zone it draws through the touch ray. Elsewhere it turns the court; two fingers turn and pinch.
    - Entering 3D flies down from the 2D view to the bench (behind the home end line when the board stands upright); leaving flies back up first.
    - Eye view: `board.flyTo` follows `skeleton.povPose`, one finger looks around, and the player's own avatar hides once the camera is in their head.
  - `web/src/app/three/Players3D.ts`: the 3D scene content.
    - Avatars use `AvatarMesh` buffers cached per stature with CPU dual-quaternion skinning, in team colours (the libero in white).
    - Each player has a label above the head and a ring on the floor; a numeric label is also printed on the chest and the back.
    - Also drawn: the ball, its shadow and its flights, zones (pattern textures, walls for tagged zones) and ink as floor ribbons, snap highlights, sight lines, and a cylinder pick for taps.
  - `Court3DView.tsx` has an `onDispose` callback, so the Studio frees what it added before the board goes.
- Video to 3D (task 2), in `web/src/app/video/`, opened from the Video to 3D locker on Home (routes `video` and `watch`):
  - `VideoImport.tsx` (route `video`), mirroring the native `VideoImportView`: three steps.
    - Choose: "Choose a video" (a file input, so Photos on the iPad), the saved videos ("Your videos": plate thumbnail, length, players; delete with a second tap) and the filming tips.
    - Mark: the still at the start + 0.2 s with four dots (THEM on their end line, US on ours) and a 3x loupe above the finger; the court lines and the net are projected back through `CourtCalibration.solveCorners` as the check, with Good fit / Rough fit. A start slider appears for clips over 10.5 s (10 s are used).
    - Build: a progress bar with the stage, Stop; then the rally opens in the watch screen.
  - `pipeline.ts` (`buildRally`): pose frames at 10 per second from `clip.ts` (a hidden `<video>`, at most 1920 px; an all-black frame right after a seek is read again), `detect.ts` on each (the pose model only for people standing near the court, from their box through the camera), the jersey colour of each person as the tracker's appearance cue. Between each two pose frames two more for the ball alone (`samplePlan`, 30 frames a second in all; `Detector.detectBalls` runs the object detector without the pose crops, about a quarter of a pose frame's time). A frame that repeats the one read before (a clip with fewer frames per second) is skipped by a 480 px fingerprint (`sameFrame`); a repeated pose frame keeps its people but not its ball. One ball pixel per frame over all of them (`pickBalls`): candidates at the same pixel in four or more frames over a second or more are left out first (`withoutFixtures`: an antenna top, a logo, a spare ball), then the candidate nearest to where the path leads is taken, down to the detector's threshold, and a new path starts only at a score of 0.2. About 24 pose frames with people masked for the clean plate. The plate and the reconstruction run in `rebuild.worker.ts` (a module worker). In dev, `globalThis.__videoDebug` keeps the last observations.
  - `rallyTracker.ts` (`RallyTracker.forCamera`): the core's tracker with two rules for real footage: tracks seen inside the lines in fewer than 3 frames are dropped before the six-per-side limit (coaches, line judges, officials), and the jump allowance (`maxFootHeight`) is cut to about 2 m along the court for a far, low camera (from 45 to 12 home detections across the net on the broadcast clip). Each player's stature (women/men from Settings) is stored with the scene.
  - `videoStore.ts`: the IndexedDB `videos` store; a record holds the encoded `VideoScene`, the clip (`clip`, left out by a backup without videos) and the plate (JPEG).
  - `VideoWatch.tsx` (route `watch`), mirroring the native `VideoWatchView`: Video | Court. The clip is the clock (without a clip, the plate and a clock of its own). Video shows a ring and the label on every player; a tap flies into that player's eyes, with the clip small in the corner (tap it to go back), Look ahead, and one finger to look around. Court shows the 3D board; a tap selects, "See what X sees" goes into the eyes; in eye view a tap on another player switches to them. The strip: play/pause, scrub, time, Slow (half speed); it stops at the end of the rally.
  - `WatchBoard.tsx` drives `Court3DView`/`Board3D` and `Players3D` (imported, not changed) from `VideoScene.frame(t).posedPlayers()` (the reconstructed facing and jump), draws the ball's flights, and opens where the video was filmed (`videoOrbit`; a broadcast telephoto opens at 40 degrees from closer by, and an upright iPad widens to 60 degrees and stands back).
  - `Hall3D.ts`: the hall box (walls, ceiling, the hall floor beyond the board) with a projective-texture shader: the clean plate through `VideoCamera.normalizedProjection`, mirror images as in the native shader, the hall colour elsewhere. Faces point inward (a doll's house from outside, closed from a player's eyes). Two checks the native shader lacks: a point counts only when the video camera meets its wall from inside the hall and its ray then lands on the floor outside the hall, and the floor only inside the hall; without them a camera in the stands paints the court or the far stands onto the top of the far wall and the boards onto the floor.
- Core ported from Swift to TypeScript with Vitest tests (160 pass, with the app's):
  - `web/src/core/match` (match domain)
  - `web/src/core/spatial` (3D math, skeleton, avatar mesh, postures, ball flight, line of sight, POV)
  - `web/src/core/zones` (zones, tactical scene, timeline, ball plan, rally autopilot). `SceneEditor.setLabel` is a web addition (player names and shirt numbers).
  - `web/src/core/video` (calibration, tracking, pose fitting, ball reconstruction, clean plate and hall, video scenes and the reconstructor), with `video.test.ts` (all of `VideoTests.swift`) and `realCalibration.test.ts`. `VideoScene`, `VideoCamera`, `BallSegment` and `HallEnvironment` have `encode`/`decode` in the Swift JSON shape; `VideoCamera.scaled` is the native app's extension. Swift's `height(of:above:)` is `heightAbove`.
- `web/src/app/video/detect.ts`: two-stage MediaPipe detection (people on an upscaled, tiled frame, then the pose per person crop). The models are downloaded at build time by `web/scripts/fetch-models.mjs`. `detect` takes an optional `wantsPose` filter.

## Studio: left out on purpose

- The field-of-view cones in 3D (the readouts and the field rings cover it).
- Two- and three-finger taps for undo and redo (the rail buttons and Cmd-Z do it).

## Video to 3D: what is left

- Checked in the Claude browser pane (desktop Chromium, iPad sizes 1180 x 820 and 820 x 1180) with a real clip: the CI's Tokyo 2020 rally (`rf_backview.gif`, 600 x 338, 14 s at 10 fps, see `.github/workflows/ci.yml`) turned into an MP4 by `web/tools/gif2video.js`; `web/tools/videoflow.js` runs the import with the corners of `RealCalibrationTests`. Result: calibration good (0.02 px RMS), 12 players, 82 ball points and 5 ball flights, all on the ball (the serve toss, the pass going up and coming down, two later in the rally); 76 s for 10 s of video (0.6 s per pose frame, 0.17 s per ball-only frame) plus 3 s of reconstruction. That clip has only 10 frames a second, so 120 of the 200 ball-only frames repeat a pose frame and are skipped; a 30 fps clip reads all 200 (95 s on the desktop, measured by switching the skip off). Before the ball-only frames and `withoutFixtures` it was 75 ball points and 4 flights in 60 s, and all four flights were the top of the right antenna, which the detector scores above the ball in most frames. **Not yet tried on the iPad itself**: Safari's seeking and drawing of frames from a .mov out of Photos, the MediaPipe GPU delegate's speed, and memory with 4K clips (the clip is stored whole).
- Tracking on broadcast footage is imperfect, as in the native app (the same core): near the net some identities still swap across teams and some detections jump to the other half. Ideas: jersey colour to decide a new track's team; a coach's tap to fix a player.
- The ball comes from the object detector's "sports ball" on 30 frames a second (the native app ran Vision's trajectory detector on every frame). Left to do:
  - The core's drag-free fit accepts flights whose depth the image does not fix: on the Tokyo clip two of the five (a ball falling almost straight down the image from a far telephoto camera) start at the camera or behind the home end. A plausibility check in `BallReconstruction` (inside the hall, a believable speed) or more hand anchors would drop or pin them.
  - Not yet tried with a real 30 or 60 fps clip (the test clip is 10 fps). Frames are timed at the requested seek time, not the frame's own time (`requestVideoFrameCallback` could give that), which adds up to one source frame of jitter.
  - The ball-only frames run both detector tiles; only the tile holding the predicted ball would halve their cost.
- The rings and labels on the video sit at the full stature above the feet (as native), so they float above a crouching player. The home players are labelled 1 to 6 by rotational position, and `Players3D` prints numeric labels on the jerseys; a way to name the players after the build would make that their shirt numbers.
- Walls the video never saw stay in the plain hall colour (as native).

## Checks before pushing

```
cd web && npx tsc -b && npx vitest run && npm run build
```
On the owner's Mac, Node is in `~/.local/node` (linked from `~/.local/bin`). In the Claude desktop app, the browser pane starts the dev server from the `coach-board-studio` entry in `~/.claude/launch.json` (Vite on port 5174); `coach-board-video` is the same on port 5176. To try Video to 3D in the pane, put the CI's rally GIF in `web/tools/frames/` (gitignored) with the `curl` line from `ci.yml`, then follow the comment at the top of `web/tools/videoflow.js`.
Commit trailers used in this repo end with a `Co-Authored-By:` line and a `Claude-Session:` line.
