import { describe, expect, it } from "vitest";
import { authenticator } from "otplib";
import {
  ctxFromRequest,
  getSessionByToken,
  loginWithPassword,
  SESSION_COOKIE,
  verifyMfa,
} from "@/lib/auth/session";
import { can, PERMISSIONS } from "@/lib/permissions";
import { sampleOrg } from "../helpers/synthetic-eval";

const bcba = sampleOrg.users.find((u) => u.role === "BCBA")!;

describe("email + password + TOTP MFA", () => {
  it("rejects a wrong password", async () => {
    expect(await loginWithPassword(bcba.email, "wrong-password")).toBeNull();
    expect(await loginWithPassword("nobody@sample-practice.test", bcba.password)).toBeNull();
  });

  it("requires a valid TOTP code before the session is usable", async () => {
    const step1 = await loginWithPassword(bcba.email, bcba.password);
    expect(step1).not.toBeNull();
    // Password alone does not authenticate.
    expect(await getSessionByToken(step1!.token)).toBeNull();
    const req = (t: string) => new Request("http://x/api", { headers: { cookie: `${SESSION_COOKIE}=${t}` } });
    await expect(ctxFromRequest(req(step1!.token))).rejects.toThrow(/Not authenticated/);
    expect(await verifyMfa(step1!.token, "000000")).toBeNull();
    const s = await verifyMfa(step1!.token, authenticator.generate(bcba.totpSecret));
    expect(s).toMatchObject({ orgId: sampleOrg.id, role: "BCBA", mfaVerified: true });
    expect(await ctxFromRequest(req(step1!.token))).toEqual({
      orgId: sampleOrg.id,
      userId: bcba.id,
      role: "BCBA",
    });
  });
});

describe("permission matrix", () => {
  it("only BCBA can approve, sign, or finalize", () => {
    for (const action of [
      "section:approve",
      "plan:sign",
      "plan:finalize",
      "goal:approve",
      "vbmapp:confirm",
    ] as const) {
      expect(can("BCBA", action)).toBe(true);
      for (const role of ["BCaBA", "RBT", "AUTH_COORDINATOR", "PARENT"] as const)
        expect(can(role, action)).toBe(false);
    }
  });
  it("RBT enters data only; coordinator handles documents and packets; parent signs only", () => {
    expect(PERMISSIONS.RBT).toEqual(["client:read", "data:enter"]);
    expect(can("AUTH_COORDINATOR", "packet:manage")).toBe(true);
    expect(can("AUTH_COORDINATOR", "section:edit")).toBe(false);
    expect(PERMISSIONS.PARENT).toEqual(["document:sign_assigned"]);
    expect(can("BCBA", "client:read_restricted")).toBe(true);
    expect(can("RBT", "client:read_restricted")).toBe(false);
  });
});
