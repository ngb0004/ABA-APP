import { toDay, type Day } from "../dates";

/** "Today" for due dates. APP_AS_OF pins it for demos and end-to-end tests. */
export function asOfToday(): Day {
  return process.env.APP_AS_OF ?? toDay(new Date());
}
