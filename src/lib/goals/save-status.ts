/**
 * What an autosaving goal editor says about its save ("Saving…", "Saved", or why not), scoped to
 * that editor's own fields. The goal dialog, the goal's status-and-dates editor, and the
 * flat-progress note share one queue; a problem in a field shown elsewhere is named, with where
 * to fix it, rather than shown as a bare "Not saved".
 */
import type { AutosaveState } from "./autosave";
import { GOAL_FIELD_HOME, GOAL_FIELD_LABEL, isGoalPatchField } from "./goal-patch";

export type SaveStatusText = { text: string; bad: boolean };

const label = (f: string) => (isGoalPatchField(f) ? GOAL_FIELD_LABEL[f] : f);
const home = (f: string) => (isGoalPatchField(f) ? GOAL_FIELD_HOME[f] : "its editor");

/** The fields that are not saved and need the person: in conflict, held back as invalid, or failed. */
export function unsavedFields(state: AutosaveState): string[] {
  return [
    ...new Set([...Object.keys(state.conflicts), ...Object.keys(state.problems), ...state.failedFields]),
  ];
}

/** "Objective and Barriers (Edit goal, in the goal's menu; the goal's status and dates)". */
export function describeFields(fields: string[]): string {
  const names = fields.map(label);
  const list = names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  const homes = [...new Set(fields.map(home))];
  return `${list} (${homes.join("; ")})`;
}

/** The status line for an editor of `fields` (all fields when null). */
export function saveStatusText(state: AutosaveState, fields: readonly string[] | null): SaveStatusText {
  const mine = (f: string) => !fields || fields.includes(f);
  if (Object.keys(state.conflicts).some(mine))
    return {
      text: "Changed somewhere else while you were editing: choose which version to keep.",
      bad: true,
    };
  if (Object.keys(state.problems).some(mine))
    return { text: "Not saved: fix the highlighted field.", bad: true };
  if (state.failedFields.some(mine)) return { text: "Not saved", bad: true };
  const elsewhere = unsavedFields(state).filter((f) => !mine(f));
  if (elsewhere.length) return { text: `Not saved yet: ${describeFields(elsewhere)}.`, bad: true };
  if (state.pendingFields.some(mine)) return { text: "Saving…", bad: false };
  if (state.savedFields.some(mine))
    return {
      text: state.returnedToDraft
        ? "Saved. Changing an approved goal returns it to draft; approve it again."
        : "Saved",
      bad: false,
    };
  return { text: "", bad: false };
}

/** Why an action on the goal (Discontinue, Approve, …) could not go ahead, or null when it can. */
export function notSavedMessage(state: AutosaveState): string {
  const fields = unsavedFields(state);
  const what = fields.length ? describeFields(fields) : "Some changes to this goal";
  return `${what} could not be saved yet. Nothing you typed was lost; fix ${fields.length === 1 ? "it" : "them"} and try again.`;
}
