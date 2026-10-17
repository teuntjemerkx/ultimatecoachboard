// Public API of the zones and tactical scenes core (port of CoachBoardCore/Geometry and CoachBoardCore/Zones).
export { SignedDistance } from "./signedDistance";
export {
  P2, ShapeKind, RecognizerParameters, SmartGeometry,
  type RecognizedShape, type LineFit, type CircleFit, type EllipseFit,
} from "./smartGeometry";
export {
  ZoneGeometry, ZonePattern, ZoneExtrusion, ZoneTint, ZoneStyle, ZoneTag, ZoneSemantic, Zone, ZoneSDF,
  type ZoneGeometryKind, type ZoneEdge,
} from "./zone";
export { ZoneSnapping, ZoneBuilder, type SnapTarget, type ZoneBuildResult } from "./zoneBuilder";
export { SceneToken, TacticalScene, SceneEditor } from "./tacticalScene";
export {
  RallyPhase, TokenKey, ZoneKey, SceneFrame, Timeline, ZoneInterpolation, automaticPosture, sceneTimeline, sceneTimeOf,
  sceneFrame, type ZoneMorph, type PostureBlend,
} from "./sceneTimeline";
export {
  ContactKind, BallContact, BallPlanSegment, BallPlan, defaultLanding, sceneBallPlan, type ContactLaunch,
} from "./ballPlan";
export {
  AttackOption, SceneSetup, PlacementAssist, templateRotations, nextRotation, previousRotation, placement, baseSpot,
  routeTarget, setterSpot, defaultBaseSlots, defaultRouteTargets, placeScene, rotateScene, placedScene, playOutScene,
  sceneLiveFrame, type PlacedPlayer,
} from "./sceneAutopilot";
export { sceneClock, sceneMotion, secondsPerPhase, type SceneClock, type SceneMotion } from "./sceneMotion";
