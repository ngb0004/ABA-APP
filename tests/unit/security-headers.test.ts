import { describe, expect, it } from "vitest";
import { securityHeaders } from "@/lib/security-headers";

describe("security headers", () => {
  const get = (prod: boolean, key: string) => securityHeaders(prod).find((h) => h.key === key)?.value;
  it("forbid framing, plugins, base-tag changes and other origins", () => {
    const csp = get(true, "Content-Security-Policy")!;
    for (const d of ["default-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'none'"])
      expect(csp).toContain(d);
    expect(csp).not.toContain("unsafe-eval");
    expect(get(true, "X-Content-Type-Options")).toBe("nosniff");
    expect(get(true, "Strict-Transport-Security")).toMatch(/max-age=\d+/);
  });
  it("allow eval only for the development server", () => {
    expect(get(false, "Content-Security-Policy")).toContain("'unsafe-eval'");
    expect(get(false, "Strict-Transport-Security")).toBeUndefined();
  });
});
