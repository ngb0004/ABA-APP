/**
 * Outbound URL checks for the rules-watch fetcher (SSRF): payor documents are fetched over https
 * from the payor's own site only, never from a private, loopback or link-local address (the cloud
 * metadata and container-credential endpoints live there), and redirects are followed one hop at a
 * time with the same checks.
 */
import { isIP } from "node:net";

export const MAX_REDIRECTS = 5;

function ipv4Private(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number) as [number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** True for addresses that are not on the public internet. */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return ipv4Private(ip);
  if (v === 6) {
    const lower = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return ipv4Private(mapped[1]!);
    return (
      lower === "::" ||
      lower === "::1" ||
      /^f[cd]/.test(lower) || // unique local fc00::/7
      /^fe[89ab]/.test(lower) // link-local fe80::/10
    );
  }
  return false;
}

/** The registrable part of a host, approximately: its last two labels ("mmis.georgia.gov" → "georgia.gov"). */
export function siteOf(host: string): string {
  return host.toLowerCase().replace(/\.$/, "").split(".").slice(-2).join(".");
}

/** Why `url` may not be fetched, or null. `site` is the seed URL's registrable domain. */
export function urlProblem(url: string, site: string | null): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "Not a valid address";
  }
  if (u.protocol !== "https:") return "Only https addresses are fetched";
  if (u.username || u.password) return "Addresses with credentials are not fetched";
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(host))
    return isPrivateAddress(host)
      ? "Private network addresses are not fetched"
      : "Bare IP addresses are not fetched";
  if (
    host === "localhost" ||
    /\.(localhost|local|internal|lan|home\.arpa)$/.test(host) ||
    !host.includes(".")
  )
    return "Private network addresses are not fetched";
  if (site && siteOf(host) !== site) return "The address left the payor's site";
  return null;
}
