/** Where a goal stands in treatment. Shared by the server and the goal editors in the browser. */
export const GOAL_STATUSES = ["new", "in_progress", "mastered", "on_hold", "discontinued"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];
export const GOAL_STATUS_LABEL: Record<GoalStatus, string> = {
  new: "new",
  in_progress: "in progress",
  mastered: "mastered",
  on_hold: "on hold",
  discontinued: "discontinued",
};
