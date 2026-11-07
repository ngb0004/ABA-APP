import { afterAll, describe, expect, it } from "vitest";
import { scrubArg } from "@/lib/server/console-scrub";
import { log, registerClientNames, scrub, setLogSink } from "@/lib/log";
import { reportRequestError } from "@/lib/server/request-error";
import { loginWithPassword, SESSION_COOKIE, verifyMfa } from "@/lib/auth/session";
import { withOrg } from "@/lib/db";
import { ForbiddenError } from "@/lib/log";
import { ctxAs, userOf } from "../helpers/ctx";
import { freshCode } from "../helpers/totp";

const lines: string[] = [];
setLogSink((l) => lines.push(l));
afterAll(() => setLogSink((l) => process.stderr.write(l + "\n")));

describe("errors outside api()", () => {
  it("a server-component throw is logged as name, digest and route only", async () => {
    lines.length = 0;
    const e = Object.assign(new Error("Unique constraint failed for Alpha Testchild SYN-AMG-000101"), {
      digest: "123abc",
    });
    await reportRequestError(e, {
      path: "/clients/0a1b2c3d-0000-4000-8000-000000000000/records",
      method: "GET",
      headers: {},
    });
    const out = lines.join("\n");
    expect(out).toContain("Unhandled page error");
    expect(out).toContain("/clients/:id/records");
    expect(out).not.toMatch(/Alpha|SYN-AMG|constraint/);
  });

  it("a page's permission refusal is audited under the signed-in person", async () => {
    const u = userOf("RBT");
    const s = await loginWithPassword(u.email, u.password);
    const v = await verifyMfa(s!.token, await freshCode(u.email, u.totpSecret));
    const since = new Date(Date.now() - 1000);
    await reportRequestError(new ForbiddenError("audit:read"), {
      path: "/audit",
      method: "GET",
      headers: { cookie: `${SESSION_COOKIE}=${v!.token}` },
    });
    const rows = await withOrg(ctxAs("BCBA"), (tx) =>
      tx.auditEvent.findMany({ where: { action: "access:denied", createdAt: { gte: since } } }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: u.id });
    expect(rows[0]!.meta).toMatchObject({ route: "/audit", permission: "audit:read", status: 403 });
  });
});

describe("console output is scrubbed", () => {
  it("scrubs errors and objects printed by the framework", () => {
    registerClientNames({
      firstName: "Quinn",
      lastName: "Zebrafield",
      preferredName: "Q-Bird",
      guardians: [{ name: "Morgan Zebrafield" }],
    });
    const text = scrubArg(
      new Error("Quinn Zebrafield (Q-Bird), guardian Morgan, 404-555-0100, 12 Elm Street, 30301"),
    );
    for (const s of ["Quinn", "Zebrafield", "Q-Bird", "Morgan", "555-0100", "Elm Street", "30301"])
      expect(text).not.toContain(s);
    expect(scrubArg({ ssn: "123-45-6789" })).not.toContain("123-45-6789");
    expect(scrub("plain")).toBe("plain");
    log.info("ok");
  });
});
