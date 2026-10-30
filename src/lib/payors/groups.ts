/** Groups payors by the state their rules apply in, for the Payor rules page. Pure: no database. */
import { STATE_NAMES, type UsState } from "./types";

export const ALL_STATES = "ALL";

export type StateGroup<P> = { key: string; label: string; payors: P[] };

/**
 * One group per state a payor lists, plus "All states" for payors with no state list
 * (TRICARE, national commercial policies). The states the practice serves come first, then
 * "All states", then (only with showAll) every other state. A payor listing several states
 * appears in each of their groups.
 */
export function groupByState<P extends { states: string[] }>(
  payors: P[],
  statesServed: string[],
  showAll: boolean,
): { groups: StateGroup<P>[]; hiddenStates: string[] } {
  const byState = new Map<string, P[]>();
  for (const p of payors)
    for (const s of p.states.length ? p.states : [ALL_STATES]) byState.set(s, [...(byState.get(s) ?? []), p]);
  const served = [...new Set(statesServed)].sort();
  const others = [...byState.keys()].filter((s) => s !== ALL_STATES && !served.includes(s)).sort();
  const group = (key: string): StateGroup<P> => ({
    key,
    label: key === ALL_STATES ? "All states" : (STATE_NAMES[key as UsState] ?? key),
    payors: byState.get(key) ?? [],
  });
  return {
    groups: [...served, ALL_STATES, ...(showAll ? others : [])].map(group),
    hiddenStates: showAll ? [] : others,
  };
}

/**
 * Where each payor's rules are shown in full: the first group it appears in. A payor listing
 * several states is shown once; its other groups only point to it (no duplicate rule rows or ids).
 */
export function homeGroups<P>(groups: StateGroup<P>[]): Map<P, StateGroup<P>> {
  const home = new Map<P, StateGroup<P>>();
  for (const g of groups) for (const p of g.payors) if (!home.has(p)) home.set(p, g);
  return home;
}
