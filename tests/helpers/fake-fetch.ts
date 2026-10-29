import { readFileSync } from "node:fs";
import type { FetchLike } from "@/lib/rules-watch/fetch";

const fx = (f: string) => readFileSync(`fixtures/payor-docs/${f}`);
const GA_PDF =
  "https://www.mmis.georgia.gov/portal/Portals/0/StaticContent/Public/ALL/Handbooks/Autism%20Spectrum%20Disorder%20Q4-October%202026%2020261001130506.pdf";

/** Serves the saved public payor documents; everything else is a 404. */
export function fakeFetch(
  overrides: Record<string, { status: number; body?: Buffer | string; type?: string }> = {},
): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (url: string, init?: { method?: string }) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    let r: { status: number; body?: Buffer | string; type?: string } = {
      status: 404,
      body: "not found",
      type: "text/html",
    };
    if (overrides[url]) r = overrides[url]!;
    else if (url.includes("mmis.georgia.gov") && url.includes("tabId/17") && init?.method === "POST")
      r = { status: 200, body: fx("ga_mmis_postback.html"), type: "text/html" };
    else if (url.includes("mmis.georgia.gov") && url.includes("tabId/17"))
      r = { status: 200, body: fx("ga_mmis_index.html"), type: "text/html" };
    else if (url === GA_PDF)
      r = { status: 200, body: fx("ga_asd_manual_2026q4.pdf"), type: "application/pdf" };
    else if (url.includes("static.cigna.com") && url.endsWith("applied-behavior-analysis.pdf"))
      r = { status: 200, body: fx("evernorth_aba_pa_928213d.pdf"), type: "application/pdf" };
    else if (url.includes("aetna.com/cpb/medical/data/600_699/0648.html"))
      r = { status: 200, body: fx("aetna_cpb_0648.html"), type: "text/html; charset=utf-8" };
    const buf = typeof r.body === "string" ? Buffer.from(r.body) : (r.body ?? Buffer.alloc(0));
    return {
      status: r.status,
      url,
      headers: {
        get: (n: string) => (n.toLowerCase() === "content-type" ? (r.type ?? null) : null),
        getSetCookie: () => [],
      },
      arrayBuffer: async () =>
        buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
      text: async () => buf.toString("utf8"),
    };
  }) as unknown as FetchLike & { calls: string[] };
  f.calls = calls;
  return f;
}
