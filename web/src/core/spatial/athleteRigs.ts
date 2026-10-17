// The measured rigs of the two athletes (written by web/tools/athletes/fit_bodies.ts).
import femaleRig from "../resources/athletes/female.json";
import maleRig from "../resources/athletes/male.json";
import type { AthleteRig } from "./athleteBody";

export const AthleteRigs: { female: AthleteRig; male: AthleteRig } = {
  female: femaleRig as unknown as AthleteRig,
  male: maleRig as unknown as AthleteRig,
};

/** The rig drawn for a team (women or men). */
export function athleteRig(women: boolean): AthleteRig {
  return women ? AthleteRigs.female : AthleteRigs.male;
}
