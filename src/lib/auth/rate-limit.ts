/**
 * Per-client-IP rate limiting for the sign-in endpoints. The in-memory token bucket is right for a
 * single app instance; with several instances, implement RateLimiter on a shared store (Redis,
 * DynamoDB) or rely on AWS WAF rate rules in front of the ALB (docs/HIPAA_DEPLOYMENT.md).
 */
import { createHmac } from "node:crypto";
import { audit } from "../audit";
import { env } from "../env";
import { HttpError } from "../log";

export type RateDecision = { allowed: boolean; retryAfterSeconds: number; firstRefusal: boolean };

export interface RateLimiter {
  /** Takes one token for `key`. firstRefusal: this is the first refused request since the last allowed one. */
  take(key: string, now?: number): RateDecision;
  /** Gives one token back (a request that turned out to succeed). */
  refund(key: string): void;
}

type Bucket = { tokens: number; at: number; refused: boolean };

/** Token bucket: `capacity` requests at once, refilled evenly over `windowMs`. */
export class InMemoryTokenBucket implements RateLimiter {
  private buckets = new Map<string, Bucket>();
  constructor(
    private capacity: number,
    private windowMs: number,
    /** Bounded memory: the oldest buckets are dropped past this many keys. */
    private maxKeys = 50_000,
  ) {}

  take(key: string, now = Date.now()): RateDecision {
    const rate = this.capacity / this.windowMs;
    let b = this.buckets.get(key);
    if (b) {
      b.tokens = Math.min(this.capacity, b.tokens + (now - b.at) * rate);
      b.at = now;
      // Re-insert so Map order tracks recency for eviction.
      this.buckets.delete(key);
    } else b = { tokens: this.capacity, at: now, refused: false };
    this.buckets.set(key, b);
    if (this.buckets.size > this.maxKeys) this.buckets.delete(this.buckets.keys().next().value!);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      b.refused = false;
      return { allowed: true, retryAfterSeconds: 0, firstRefusal: false };
    }
    const firstRefusal = !b.refused;
    b.refused = true;
    return { allowed: false, retryAfterSeconds: Math.ceil((1 - b.tokens) / rate / 1000), firstRefusal };
  }

  refund(key: string): void {
    const b = this.buckets.get(key);
    if (b) b.tokens = Math.min(this.capacity, b.tokens + 1);
  }
}

/**
 * The client's address from X-Forwarded-For, trusting only the last `trustedProxies` hops: each
 * trusted proxy appends the address it received the connection from, so the client is the entry
 * the outermost trusted proxy wrote. Entries before it are whatever the client sent and are ignored.
 * Without a proxy, Next.js sets the header to the socket address when the client sent none.
 */
export function clientIp(headers: Headers, trustedProxies: number): string {
  if (trustedProxies <= 0) return "untrusted";
  const hops = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return hops[hops.length - trustedProxies] ?? hops[0] ?? "unknown";
}

/** Keyed hash for identifiers in audit rows (IP addresses and emails are identifiers; never stored raw). */
export function identifierHash(value: string): string {
  return createHmac("sha256", env().SESSION_SECRET)
    .update(`id:${value.trim().toLowerCase()}`)
    .digest("hex")
    .slice(0, 32);
}

let limiter: RateLimiter | undefined;
let limiterConfig = "";
export function authRateLimiter(): RateLimiter {
  const e = env();
  const config = `${e.AUTH_RATE_LIMIT_MAX}/${e.AUTH_RATE_LIMIT_WINDOW_SECONDS}`;
  if (!limiter || config !== limiterConfig) {
    limiter = new InMemoryTokenBucket(e.AUTH_RATE_LIMIT_MAX, e.AUTH_RATE_LIMIT_WINDOW_SECONDS * 1000);
    limiterConfig = config;
  }
  return limiter;
}

/** For tests: a fresh limiter (or a substitute such as a shared-store implementation). */
export function setAuthRateLimiter(l: RateLimiter | undefined) {
  limiter = l;
  limiterConfig = l ? `${env().AUTH_RATE_LIMIT_MAX}/${env().AUTH_RATE_LIMIT_WINDOW_SECONDS}` : "";
}

export const RATE_LIMITED_MESSAGE =
  "Too many sign-in attempts from this network. Try again in a few minutes.";

/**
 * Called first by every sign-in endpoint: takes a token for the client IP, or throws 429. The
 * endpoint gives the token back when the step succeeds (refundAuthRateLimit), so the limit counts
 * failed and refused attempts: a practice whose staff all sign in from one office address is
 * never blocked by its own successful sign-ins.
 */
export async function assertAuthRateLimit(req: Request, endpoint: string): Promise<void> {
  const ip = clientIp(req.headers, env().TRUSTED_PROXY_COUNT);
  const d = authRateLimiter().take(ip);
  if (d.allowed) return;
  // One audit row per burst, not one per refused request, so an attack cannot flood the table.
  if (d.firstRefusal)
    await audit(null, {
      action: "auth:rate_limited",
      entityType: "Endpoint",
      entityId: endpoint,
      orgId: null,
      userId: null,
      meta: { ipHash: identifierHash(ip) },
    });
  throw new HttpError(429, RATE_LIMITED_MESSAGE, undefined, { retryAfterSeconds: d.retryAfterSeconds });
}

/** The step succeeded: its token goes back to the client IP's bucket. */
export function refundAuthRateLimit(req: Request): void {
  authRateLimiter().refund(clientIp(req.headers, env().TRUSTED_PROXY_COUNT));
}
