import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { authenticator } from "otplib";
import { assertDemoUploadAllowed, DEMO_SAMPLES, sampleFile } from "@/lib/demo";
import { db } from "@/lib/db";
import {
  confirmMfaEnrollment,
  getSessionByToken,
  loginWithPassword,
  startMfaEnrollment,
} from "@/lib/auth/session";
import { authProvider } from "@/lib/auth/local";
import { api } from "@/lib/server/api";
import { sampleOrg } from "../helpers/synthetic-eval";

afterEach(() => {
  delete process.env.DEMO_MODE;
});

describe("demo mode uploads", () => {
  it("accepts every bundled sample and rejects anything else", () => {
    process.env.DEMO_MODE = "true";
    for (const k of ["vbmapp", "letters"] as const)
      for (const n of DEMO_SAMPLES[k]) expect(() => assertDemoUploadAllowed(sampleFile(k, n))).not.toThrow();
    const edited = Buffer.concat([
      readFileSync("fixtures/letters/denial.txt"),
      Buffer.from("\nReal patient: someone"),
    ]);
    expect(() => assertDemoUploadAllowed(edited)).toThrow(/only the bundled sample files/);
  });
  it("does not restrict uploads outside demo mode", () => {
    expect(() => assertDemoUploadAllowed(Buffer.from("anything"))).not.toThrow();
  });
  it("only serves whitelisted sample names", () => {
    expect(() => sampleFile("letters", "../../.env")).toThrow(/Unknown sample/);
  });
});

describe("first sign-in authenticator enrollment", () => {
  it("enrolls a user without MFA and completes sign-in with the first code", async () => {
    const email = "enroll-test@sample-practice.test";
    await db().user.deleteMany({ where: { email } });
    const { userId } = await authProvider().createUser({
      email,
      name: "Enroll Test",
      password: "enroll-test-password",
    });
    const bcba = sampleOrg.users.find((u) => u.role === "BCBA")!;
    // Reuse the sample org membership so the session can bind to an org.
    const { withOrg } = await import("@/lib/db");
    await withOrg({ orgId: sampleOrg.id, userId: bcba.id, role: "BCBA" }, (tx) =>
      tx.membership.create({ data: { orgId: sampleOrg.id, userId, role: "RBT" } }),
    );

    const step1 = await loginWithPassword(email, "enroll-test-password");
    expect(step1!.mfaEnabled).toBe(false);
    expect(await getSessionByToken(step1!.token)).toBeNull();
    const en = await startMfaEnrollment(step1!.token);
    expect(en!.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    expect(await confirmMfaEnrollment(step1!.token, "000000")).toBeNull();
    const s = await confirmMfaEnrollment(step1!.token, authenticator.generate(en!.secret));
    expect(s).toMatchObject({ mfaVerified: true, role: "RBT", orgId: sampleOrg.id });
    // Once enrolled, enrollment cannot be restarted from a password-only session.
    const again = await loginWithPassword(email, "enroll-test-password");
    await expect(startMfaEnrollment(again!.token)).rejects.toMatchObject({ status: 409 });
  });
});

describe("route ids", () => {
  it("returns 404 for a malformed id before touching the database", async () => {
    const step1 = await loginWithPassword(sampleOrg.users[0]!.email, sampleOrg.users[0]!.password);
    const { verifyMfa, SESSION_COOKIE } = await import("@/lib/auth/session");
    await verifyMfa(step1!.token, authenticator.generate(sampleOrg.users[0]!.totpSecret));
    const handler = api<{ id: string }>(async () => ({ reached: true }));
    const res = await handler(
      new Request("http://x/api/plans/undefined", {
        headers: { cookie: `${SESSION_COOKIE}=${step1!.token}` },
      }),
      { params: Promise.resolve({ id: "undefined" }) },
    );
    expect(res.status).toBe(404);
  });
});
