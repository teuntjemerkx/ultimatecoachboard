// Public API of the 3D/spatial core (port of CoachBoardCore/Spatial).
export { V3, Quat, Rigid, DualQuat, Mat4 } from "./math3d";
export {
  Joint, allJoints, jointParent, jointName, BodyMetrics, SkeletonModel, Posture, AvatarMaterial, AvatarMesh,
} from "./skeleton";
export {
  PostureSpec, PostureLibrary, PoseParams,
  type PostureSpecRoot, type PositionTraits, type PostureLibraryPosition, type PostureLibraryFile,
} from "./postureLibrary";
export { Stride, strideParams, type StrideMotion } from "./gait";
export { CameraPose } from "./cameraPose";
export { BoardCamera, criticallyDamped } from "./boardCamera";
export { Aero, BallFlight, NetCrossing, Trajectory, FlightSolver, type FlightSample } from "./ballFlight";
export {
  OccluderPart, Capsule, OccluderModel, Visibility, LineOfSight, VisualField, type VisualBand,
} from "./lineOfSight";
export {
  PlayerBodies, defaultStature, effectiveStature, PosedPlayer, posedPlayers, GazeReadout, Gaze, type GazeAim,
} from "./povAnalysis";
