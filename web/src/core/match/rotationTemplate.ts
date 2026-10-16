// TEMP STAND-IN: replaced by the match port
// Minimal port of Templates/RotationTemplate.swift (and TemplateLibrary.template / sixTwo of TeamSystem.swift) so
// spatial/ and zones/ compile and test before the match port lands. Fields are those of the JSON files.
import fiveOneOutside from "../resources/templates/5-1-outside-follows-setter.json";
import fiveOneMiddle from "../resources/templates/5-1-middle-follows-setter.json";
import fourTwo from "../resources/templates/4-2.json";
import youthW from "../resources/templates/youth-w.json";

export interface RotationTemplateLibero {
  replaces: string[];
  whenServing: boolean;
}

export interface RotationTemplatePlayer {
  role: string;
  position: number;
  anchor: number[];
  passes: boolean;
  route?: string | null;
  switchTo?: number[] | null;
}

export interface RotationTemplateFormation {
  rotation: number;
  phase: string;
  players: RotationTemplatePlayer[];
  expectedMinMargin?: number | null;
  frontSetterPosition?: number | null;
  note?: string | null;
}

/** A rotation template file (Appendix B5, format "cb.rotation-template/1"). */
export interface RotationTemplate {
  format: string;
  id: string;
  system: string;
  lineupOrder: string[];
  libero?: RotationTemplateLibero | null;
  setterTarget: number[];
  routeTargets: Record<string, number[]>;
  baseSlots?: Record<string, number[]> | null;
  formations: RotationTemplateFormation[];
  note?: string | null;
}

const files: Record<string, unknown> = {
  "5-1-outside-follows-setter": fiveOneOutside,
  "5-1-middle-follows-setter": fiveOneMiddle,
  "4-2": fourTwo,
  "youth-w": youthW,
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export const TemplateLibrary = {
  shippedIDs: ["5-1-outside-follows-setter", "5-1-middle-follows-setter", "4-2", "youth-w"],

  shipped(id: string): RotationTemplate {
    const file = files[id];
    if (!file) throw new Error(`resourceMissing: ${id}.json`);
    return clone(file) as RotationTemplate;
  },

  /** A template by id, including the 6-2, which is derived from the verified 5-1 (Appendix A4). */
  template(id: string): RotationTemplate {
    if (id === "6-2") return TemplateLibrary.sixTwo(TemplateLibrary.shipped("5-1-outside-follows-setter"));
    return TemplateLibrary.shipped(id);
  },

  sixTwo(fiveOne: RotationTemplate): RotationTemplate {
    const t = clone(fiveOne);
    t.id = "6-2";
    t.system = "6-2";
    t.lineupOrder = ["S1", "OH1", "MB1", "S2", "OH2", "MB2"];
    t.formations = fiveOne.formations
      .filter((f) => [1, 6, 5].includes(f.rotation))
      .map((f0) => {
        const f = clone(f0);
        for (const p of f.players) {
          if (p.role === "S") p.role = "S1";
          else if (p.role === "OPP") p.role = "S2";
        }
        f.note = `6-2 formation derived from 5-1 R${f.rotation}`;
        return f;
      });
    t.note = "Indexed by the back-row setter's position; S1 is whichever setter is in the back row.";
    return t;
  },
};
