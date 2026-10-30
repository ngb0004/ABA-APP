/**
 * The "Draft with AI" request. A draft can take half a minute, and a proxy in
 * front of the app may answer 502/503/504 or drop the connection while it waits.
 * Those are retried once; if the retry also fails, the BCBA sees a plain message
 * instead of "Request failed".
 */

export const DRAFT_DROPPED_MESSAGE = "The AI took too long or the connection dropped. Try again.";
const GATEWAY_STATUSES = new Set([502, 503, 504]);

export type DraftResponse = { ok: boolean; data: Record<string, unknown> };

export async function requestDraft(
  url: string,
  doFetch: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<DraftResponse> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
    } catch {
      continue;
    }
    if (GATEWAY_STATUSES.has(res.status)) continue;
    const data = res.headers.get("content-type")?.includes("json")
      ? ((await res.json().catch(() => ({}))) as Record<string, unknown>)
      : {};
    return { ok: res.ok, data };
  }
  return { ok: false, data: { error: DRAFT_DROPPED_MESSAGE } };
}
