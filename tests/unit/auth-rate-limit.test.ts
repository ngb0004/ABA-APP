import { describe, expect, it } from "vitest";
import { clientIp, InMemoryTokenBucket } from "@/lib/auth/rate-limit";

describe("token bucket", () => {
  it("allows the capacity at once, then refills evenly over the window", () => {
    const b = new InMemoryTokenBucket(20, 300_000);
    const t = 1_000_000;
    for (let i = 0; i < 20; i++) expect(b.take("a", t).allowed).toBe(true);
    const refused = b.take("a", t);
    expect(refused).toEqual({ allowed: false, retryAfterSeconds: 15, firstRefusal: true });
    expect(b.take("a", t + 1000).firstRefusal).toBe(false);
    // One token per 15 seconds.
    expect(b.take("a", t + 14_999).allowed).toBe(false);
    expect(b.take("a", t + 15_000).allowed).toBe(true);
    expect(b.take("a", t + 15_001).allowed).toBe(false);
    // Never more than the capacity, however long it waits.
    for (let i = 0; i < 20; i++) expect(b.take("a", t + 10 * 300_000).allowed).toBe(true);
    expect(b.take("a", t + 10 * 300_000).allowed).toBe(false);
    // Keys are independent.
    expect(b.take("b", t).allowed).toBe(true);
  });

  it("a refund gives one token back, never above the capacity", () => {
    const b = new InMemoryTokenBucket(2, 300_000);
    b.take("a", 0);
    b.take("a", 0);
    expect(b.take("a", 0).allowed).toBe(false);
    b.refund("a");
    expect(b.take("a", 0).allowed).toBe(true);
    b.refund("a");
    b.refund("a");
    b.refund("a");
    expect(b.take("a", 0).allowed).toBe(true);
    expect(b.take("a", 0).allowed).toBe(true);
    expect(b.take("a", 0).allowed).toBe(false);
  });

  it("keeps memory bounded by dropping the least recently used keys", () => {
    const b = new InMemoryTokenBucket(1, 300_000, 3);
    for (const k of ["a", "b", "c"]) b.take(k, 0);
    b.take("a", 1);
    b.take("d", 2);
    // "b" was the oldest and was dropped, so it starts full again; "a" was kept.
    expect(b.take("b", 3).allowed).toBe(true);
    expect(b.take("a", 3).allowed).toBe(false);
  });
});

describe("client IP from X-Forwarded-For", () => {
  const h = (xff?: string) => new Headers(xff ? { "x-forwarded-for": xff } : {});
  it("trusts only the configured number of proxy hops", () => {
    expect(clientIp(h("203.0.113.5"), 1)).toBe("203.0.113.5");
    // Whatever the client sent before the proxy's own entry is ignored.
    expect(clientIp(h("1.2.3.4, 203.0.113.5"), 1)).toBe("203.0.113.5");
    expect(clientIp(h("1.2.3.4, 203.0.113.5, 10.0.0.1"), 2)).toBe("203.0.113.5");
    expect(clientIp(h("203.0.113.5"), 2)).toBe("203.0.113.5");
    expect(clientIp(h(), 1)).toBe("unknown");
    // 0: the header is not trusted at all; every client shares one bucket.
    expect(clientIp(h("203.0.113.5"), 0)).toBe("untrusted");
  });
});
