/**
 * Finds and downloads the current version of a payor document, and extracts
 * its text. Public documents only: no logins, no portals. Every anomaly
 * (HTTP error, empty or challenge page, missing title) is reported as broken,
 * never as "unchanged".
 */
import type { Locator } from "../payors/types";
import {
  parseAetnaCpbDates,
  parseGaRevisionRecord,
  nextQuarterStart,
  usDateToIso,
  type RevisionRow,
} from "./parsers";
import { htmlToText, normalizeText, textSha256 } from "./text";
import { PDF_LIMITS, readPdfText } from "../pdf/guard";
import { lookup } from "node:dns/promises";
import { isPrivateAddress, MAX_REDIRECTS, siteOf, urlProblem } from "./safe-url";

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; redirect?: "follow" | "manual" },
) => Promise<{
  status: number;
  url: string;
  headers: { get(name: string): string | null; getSetCookie?(): string[] };
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}>;

export const USER_AGENT = "ABA-Plan-Assistant-RulesWatch/1.0 (public policy document monitor)";
export const MAX_BYTES = 25 * 1024 * 1024;
/** Extracted text shorter than this is treated as an empty or challenge page. */
export const MIN_TEXT = 400;

export type FetchedDocument =
  | {
      ok: true;
      resolvedUrl: string;
      contentType: string;
      byteLength: number;
      text: string;
      textSha256: string;
      versionLabel: string | null;
      effectiveDate: string | null;
      nextRevision: string | null;
      revisions: RevisionRow[];
    }
  | { ok: false; error: string; resolvedUrl: string | null };

/** Refuses a host whose DNS answer is a private, loopback or link-local address. */
async function assertPublicHost(url: string) {
  const host = new URL(url).hostname;
  const addrs = await lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address)))
    throw Object.assign(new Error("private address"), { cause: { code: "PRIVATE_ADDRESS" } });
}

/** Real network fetch with a timeout. Callers follow redirects themselves (followSafely). */
export const defaultFetch: FetchLike = async (url, init) => {
  await assertPublicHost(url);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 45_000);
  try {
    return await fetch(url, {
      ...init,
      headers: { "user-agent": USER_AGENT, ...(init?.headers ?? {}) },
      signal: ctl.signal,
    });
  } finally {
    clearTimeout(t);
  }
};

/** Text of a PDF or HTML document. */
export async function extractDocumentText(bytes: Buffer, contentType: string, url: string): Promise<string> {
  return extract(bytes, contentType, url);
}

async function extract(bytes: Buffer, contentType: string, url: string): Promise<string> {
  const isPdf =
    contentType.includes("pdf") || bytes.subarray(0, 5).toString() === "%PDF-" || /\.pdf($|\?)/i.test(url);
  // Payor documents are untrusted files too: same guarded, memory-limited reader as uploads.
  if (isPdf) return readPdfText(bytes, PDF_LIMITS.payorDocument);
  return htmlToText(bytes.toString("utf8"));
}

/** Reading a body can stall after the headers arrive, so it gets its own deadline. */
const BODY_TIMEOUT_MS = 60_000;
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([
    p,
    new Promise<T>(
      (_, rej) =>
        (t = setTimeout(() => rej(Object.assign(new Error("timeout"), { name: "AbortError" })), ms)),
    ),
  ]).finally(() => clearTimeout(t));
}

type FetchRes = Awaited<ReturnType<FetchLike>>;

/** Thrown when a hop fails the URL checks; reported as a broken source, never fetched. */
class BlockedUrl extends Error {
  constructor(
    public reason: string,
    public url: string,
  ) {
    super(reason);
  }
}

/**
 * Fetches with redirects followed by hand: each hop must pass urlProblem() (https, the seed's own
 * site, no private address), and at most MAX_REDIRECTS hops are followed.
 */
export async function followSafely(
  fetcher: FetchLike,
  url: string,
  init: Parameters<FetchLike>[1] = {},
  site: string | null = null,
): Promise<{ res: FetchRes; finalUrl: string }> {
  const allowed = site ?? siteOf(new URL(url).hostname);
  let current = url;
  let req = { ...init };
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const problem = urlProblem(current, allowed);
    if (problem) throw new BlockedUrl(problem, current);
    const res = await fetcher(current, { ...req, redirect: "manual" });
    const location = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || !location) return { res, finalUrl: res.url || current };
    current = new URL(location, current).toString();
    // 303 (and 301/302 after a POST) continue as a GET without the body, like a browser.
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && req.method === "POST")) {
      req = { ...req, method: "GET" };
      delete req.body;
    }
  }
  throw new BlockedUrl("Too many redirects", current);
}

async function download(fetcher: FetchLike, url: string, init?: Parameters<FetchLike>[1]) {
  const { res, finalUrl } = await followSafely(fetcher, url, init);
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > MAX_BYTES) return { res, finalUrl, bytes: null as Buffer | null, tooLarge: true };
  const bytes = Buffer.from(await withTimeout(res.arrayBuffer(), BODY_TIMEOUT_MS));
  return { res, finalUrl, bytes, tooLarge: bytes.length > MAX_BYTES };
}

function fail(error: string, resolvedUrl: string | null = null): FetchedDocument {
  return { ok: false, error, resolvedUrl };
}

/** Georgia MMIS: GET the index, find the row by title, post back to get the current file path. */
async function resolveGaMmis(
  fetcher: FetchLike,
  indexUrl: string,
  title: string,
): Promise<{ url: string; listedDate: string | null } | { error: string }> {
  const { res: r } = await followSafely(fetcher, indexUrl);
  if (r.status !== 200) return { error: `Index page returned HTTP ${r.status}` };
  const html = await withTimeout(r.text(), BODY_TIMEOUT_MS);
  const cookies = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  // Rows: a postback link, then cells. Compare decoded cell text, so "&amp;" and "&#39;" titles match too.
  const want = normalizeText(title).toLowerCase();
  let target: string | null = null;
  let listedDate: string | null = null;
  for (const tr of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const pb = /__doPostBack\(&#39;([^&'"]+)&#39;/.exec(tr[1]!) ?? /__doPostBack\('([^']+)'/.exec(tr[1]!);
    if (!pb) continue;
    const cells = [...tr[1]!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) =>
      normalizeText(htmlToText(c[1]!)),
    );
    if (!cells.some((c) => c.toLowerCase() === want)) continue;
    target = pb[1]!;
    listedDate = usDateToIso(cells.find((c) => /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(c)) ?? "");
    break;
  }
  if (!target) return { error: `"${title}" is no longer listed on the index page` };
  const row = [null, target] as const;
  const form = new URLSearchParams();
  for (const m of html.matchAll(/<input[^>]+type="hidden"[^>]*>/g)) {
    const name = /name="([^"]+)"/.exec(m[0])?.[1];
    const value = /value="([^"]*)"/.exec(m[0])?.[1] ?? "";
    if (name)
      form.set(
        name,
        value
          .replace(/&#39;/g, "'")
          .replace(/&quot;/g, '"')
          .replace(/&amp;/g, "&"),
      );
  }
  form.set("__EVENTTARGET", row[1]!);
  form.set("__EVENTARGUMENT", "");
  const action = /<form[^>]+action="([^"]+)"/.exec(html)?.[1]?.replace(/&amp;/g, "&") ?? indexUrl;
  const postUrl = new URL(action, indexUrl);
  // Never post (with the site's cookies) anywhere but the index page's own site.
  if (postUrl.origin !== new URL(indexUrl).origin)
    return { error: "The index page's form points to another site" };
  const { res: post } = await followSafely(fetcher, postUrl.toString(), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(cookies ? { cookie: cookies } : {}) },
    body: form.toString(),
  });
  const body = await withTimeout(post.text(), BODY_TIMEOUT_MS);
  const path =
    /(\/?portal\/[^'"]*?StaticContent\/[^'"]+?\.pdf)/i.exec(body)?.[1] ??
    /(StaticContent\/[^'"]+?\.pdf)/i.exec(body)?.[1];
  if (!path) return { error: "Could not find the document link after selecting it on the index page" };
  const base = new URL(indexUrl);
  const url = path.startsWith("/")
    ? `${base.origin}${path}`
    : new URL(path.startsWith("portal/") ? `/${path}` : `/portal/Portals/0/${path}`, base.origin).toString();
  return { url: encodeURI(decodeURI(url)), listedDate };
}

export async function fetchCurrentDocument(
  locator: Locator,
  fetcher: FetchLike = defaultFetch,
): Promise<FetchedDocument> {
  let url: string;
  let listedDate: string | null = null;
  try {
    if (locator.kind === "ga_mmis_index") {
      const r = await resolveGaMmis(fetcher, locator.indexUrl, locator.title);
      if ("error" in r) return fail(r.error);
      url = r.url;
      listedDate = r.listedDate;
    } else url = locator.url;

    const { res, finalUrl, bytes, tooLarge } = await download(fetcher, url);
    const resolvedUrl = finalUrl;
    if (res.status !== 200) return fail(`HTTP ${res.status}`, resolvedUrl);
    if (tooLarge || !bytes) return fail("Document too large", resolvedUrl);
    if (bytes.length === 0) return fail("Empty response", resolvedUrl);
    // Each locator knows what a real document looks like; anything else (an error or login page) is broken.
    if (locator.kind === "ga_mmis_index") {
      if (new URL(resolvedUrl).origin !== new URL(locator.indexUrl).origin)
        return fail("The document link left the payor's site", resolvedUrl);
      if (bytes.subarray(0, 5).toString() !== "%PDF-")
        return fail("Expected a PDF but got another kind of page", resolvedUrl);
    }
    const contentType = res.headers.get("content-type") ?? "application/octet-stream";
    const text = normalizeText(await extract(bytes, contentType, resolvedUrl));
    if (text.length < MIN_TEXT)
      return fail("Page had almost no text (blocked, empty, or needs a browser)", resolvedUrl);

    // Payor-specific version signals.
    let versionLabel: string | null = null;
    let effectiveDate: string | null = listedDate;
    let nextRevision: string | null = null;
    let revisions: RevisionRow[] = [];
    if (locator.kind === "ga_mmis_index") {
      revisions = parseGaRevisionRecord(text);
      effectiveDate =
        listedDate ??
        revisions
          .map((r) => r.date)
          .sort()
          .at(-1) ??
        null;
      versionLabel = effectiveDate ? `Effective ${effectiveDate}` : null;
      nextRevision = effectiveDate ? nextQuarterStart(effectiveDate) : null;
    } else if (/aetna\.com\/cpb\//i.test(resolvedUrl)) {
      const d = parseAetnaCpbDates(text);
      if (!d.lastReview)
        return fail(
          "The policy page is missing its review dates (layout changed or not the policy)",
          resolvedUrl,
        );
      effectiveDate = d.lastReview;
      nextRevision = d.nextReview;
      versionLabel = d.lastReview ? `Last review ${d.lastReview}` : null;
    }
    return {
      ok: true,
      resolvedUrl,
      contentType,
      byteLength: bytes.length,
      text,
      textSha256: textSha256(text),
      versionLabel,
      effectiveDate,
      nextRevision,
      revisions,
    };
  } catch (e) {
    if (e instanceof BlockedUrl) return fail(e.reason, e.url);
    const err = e as { name?: string; cause?: { code?: string } };
    return fail(
      err.name === "AbortError" ? describeNetworkError("TIMEOUT") : describeNetworkError(err.cause?.code),
    );
  }
}

const CERT_CODES = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_UNTRUSTED",
]);
const UNREACHABLE_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_SOCKET",
]);
const TIMEOUT_CODES = new Set(["TIMEOUT", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT"]);

/** Plain-language text for a network failure. The raw code stays in brackets for whoever investigates. */
export function describeNetworkError(code?: string | null): string {
  if (code === "TIMEOUT") return "Timed out: the site took too long to respond";
  const suffix = code ? ` [${code}]` : "";
  if (code && CERT_CODES.has(code))
    return `Could not connect securely: the site's security certificate could not be checked${suffix}`;
  if (code && UNREACHABLE_CODES.has(code)) return `Could not reach the site${suffix}`;
  if (code && TIMEOUT_CODES.has(code)) return `Timed out: the site took too long to respond${suffix}`;
  return `Could not connect to the site${suffix}`;
}
