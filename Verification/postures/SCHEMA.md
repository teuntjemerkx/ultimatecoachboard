# Posture research format (one JSON file per position)

All angles in DEGREES, anatomical, relative to the standing anatomical position
(standing upright, arms hanging at the sides, palms toward the thighs, facing forward).

Keys inside "angles" (omit a key = 0):
- lumbar_flex, thoracic_flex: forward bend of the lower / upper trunk segment relative to the segment below
  (positive forward; negative = arching back). Their sum is the trunk's lean from vertical.
- trunk_lateral: side bend, positive toward the player's RIGHT.
- trunk_twist: axial rotation of the chest relative to the pelvis, positive = chest turns to the player's RIGHT
  (e.g. a right-handed hitter cocking the arm turns the chest to the right, about +30..45).
- neck_flex: positive = chin down, negative = looking up.
- l_/r_shoulder_flex: 0 = arm hanging, 90 = arm pointing straight forward, 180 = arm straight overhead.
- l_/r_shoulder_abd: 0 = arm at the side, 90 = arm straight out sideways (frontal plane).
  (An overhead arm in the scapular plane is e.g. flex 160 + abd 25.)
- l_/r_shoulder_ext_rot: external rotation of the upper arm (positive = forearm turns up/back when the elbow is
  bent 90 deg and the arm is raised; arm cock in a spike is about 90..160).
- l_/r_elbow_flex: 0 = straight.
- l_/r_wrist_ext: positive = hand bends back (extension), negative = flexion.
- l_/r_hip_flex: positive = thigh forward/up.
- l_/r_hip_abd: positive = leg out to the side.
- l_/r_hip_ext_rot: positive = knee/toes turned out.
- l_/r_knee_flex: 0 = straight.
- l_/r_ankle_dorsi: positive = shin tilted forward over the foot; negative = plantarflexion (toe push).

"root" (whole body):
- jump_m: height of the feet above the floor at this instant (0 when grounded).
- stance_width_m: lateral distance between the two feet centres (grounded postures).
- stagger_m: positive = RIGHT foot ahead of the left (along the facing direction).
- yaw_deg: body (pelvis) rotation relative to facing the net squarely, positive = turned to the player's LEFT.

File layout:
{
  "position": "setter | outside_hitter | opposite | middle_blocker | libero",
  "traits": {
    "stature_m": {"elite_men": .., "elite_women": .., "youth_women_u16": ..},
    "standing_reach_m": {...}, "spike_reach_m": {...}, "block_reach_m": {...},
    "build_notes": "body build / proportions / typical gear (knee pads, sleeves, libero jersey)",
    "sources": ["url", ...]
  },
  "techniques": [
    {
      "id": "snake_case id from the list below (or a new position-specific id)",
      "name": "human name",
      "phase": "e.g. ready | contact | take-off | arm cock | peak | landing",
      "handedness": "right (assume a right-handed player; mirror is automatic)",
      "description": "2-4 sentences: what the body does at this instant, key visual cues a coach recognizes",
      "root": {"jump_m": 0, "stance_width_m": 0.5, "stagger_m": 0.1, "yaw_deg": 0},
      "angles": { "lumbar_flex": 10, "...": 0 },
      "confidence": "measured (from a study) | estimated (from coaching texts / technique analysis)",
      "evidence": ["url or short citation", ...]
    }
  ],
  "sources": [ {"title": "...", "url": "...", "type": "study | coaching manual | technique article | video analysis | photo caption/gallery", "used_for": ["technique ids"]} ]
}

Shared technique ids (fill all that the position really performs; add position-specific variants with new ids):
ready_high, ready_medium, ready_low,
pass_platform, pass_platform_angled, overhead_pass,
dig_low, dig_sprawl, dig_collapse,
set_front_contact, set_back_contact, set_jump_contact, setter_dump,
approach_penultimate, approach_takeoff, attack_arm_cock, attack_contact, attack_landing,
backrow_attack_contact, quick_attack_contact, slide_takeoff,
block_ready, block_footwork_crossover, block_jump_peak, block_landing,
serve_float_toss, serve_float_contact, serve_jump_toss, serve_jump_contact,
cover, transition_retreat, free_ball_ready
