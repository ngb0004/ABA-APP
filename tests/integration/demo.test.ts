import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { authenticator } from "otplib";
import { ASSESSMENT_SAMPLE_TYPES, assertDemoUploadAllowed, DEMO_SAMPLES, sampleFile } from "@/lib/demo";
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
    for (const k of ["vbmapp", "letters", "assessments"] as const)
      for (const n of DEMO_SAMPLES[k]) expect(() => assertDemoUploadAllowed(sampleFile(k, n))).not.toThrow();
    const edited = Buffer.concat([
      readFileSync("fixtures/letters/denial.txt"),
      Buffer.from("\nReal patient: someone"),
    ]);
    expect(() => assertDemoUploadAllowed(edited)).toThrow(/only the bundled sample files/);
    // A re-saved copy of a sample score file is not a sample any more.
    const png = Buffer.concat([readFileSync("fixtures/assessments/srs2_scores.png"), Buffer.from([0])]);
    expect(() => assertDemoUploadAllowed(png)).toThrow(/only the bundled sample files/);
  });
  // (File permissions are not checked: git does not keep read-only bits, so a fresh clone differs.)
  it("every sample score file is listed with the assessment it holds, and exists", () => {
    for (const n of DEMO_SAMPLES.assessments) {
      expect(ASSESSMENT_SAMPLE_TYPES[n]).toMatch(/^[a-z0-9_]+(:[a-z0-9_]+)?$/);
      expect(statSync(`fixtures/assessments/${n}`).isFile()).toBe(true);
    }
  });
  it("the demo refuses an uploaded score file that is not a sample", async () => {
    process.env.DEMO_MODE = "true";
    const { uploadAssessmentImport } = await import("@/lib/services/assessment-imports");
    const { clientId, ctxAs } = await import("../helpers/ctx");
    await expect(
      uploadAssessmentImport(ctxAs("BCBA"), clientId("client3"), {
        filename: "mine.txt",
        data: Buffer.from("Autism Composite: 63"),
        typeKey: "pddbi",
      }),
    ).rejects.toMatchObject({ status: 403 });
    const ok = await uploadAssessmentImport(ctxAs("BCBA"), clientId("client3"), {
      filename: "pddbi_parent.txt",
      data: sampleFile("assessments", "pddbi_parent.txt"),
      typeKey: "pddbi",
    });
    expect(ok.importId).toBeTruthy();
  });
  it("does not restrict uploads outside demo mode", () => {
    expect(() => assertDemoUploadAllowed(Buffer.from("anything"))).not.toThrow();
  });
  it("only serves whitelisted sample names", () => {
    expect(() => sampleFile("letters", "../../.env")).toThrow(/Unknown sample/);
  });
});

describe("first sign-in authenticator enrollment", () => {
  async function freshUser(email: string) {
    const { withOrg } = await import("@/lib/db");
    const existing = await db().user.findUnique({ where: { email } });
    if (existing) {
      await db().authSession.deleteMany({ where: { userId: existing.id } });
      await withOrg({ orgId: sampleOrg.id, userId: null, role: null }, (tx) =>
        tx.membership.deleteMany({ where: { userId: existing.id } }),
      );
      await db().user.delete({ where: { id: existing.id } });
    }
    const { userId } = await authProvider().createUser({
      email,
      name: "Enroll Test",
      password: "enroll-test-password",
    });
    await withOrg({ orgId: sampleOrg.id, userId: null, role: null }, (tx) =>
      tx.membership.create({ data: { orgId: sampleOrg.id, userId, role: "RBT" } }),
    );
    return userId;
  }

  it("enrolls a user without MFA and completes sign-in with the first code", async () => {
    const email = "enroll-test@sample-practice.test";
    await freshUser(email);
    const step1 = await loginWithPassword(email, "enroll-test-password");
    expect(step1!.mfaEnabled).toBe(false);
    expect(await getSessionByToken(step1!.token)).toBeNull();
    const en = await startMfaEnrollment(step1!.token);
    expect(en!.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    // Nothing is written to the user until a code confirms.
    expect((await db().user.findUniqueOrThrow({ where: { email } })).totpSecret).toBeNull();
    expect(await confirmMfaEnrollment(step1!.token, "000000")).toBeNull();
    const s = await confirmMfaEnrollment(step1!.token, authenticator.generate(en!.secret));
    expect(s).toMatchObject({ mfaVerified: true, role: "RBT", orgId: sampleOrg.id });
    const again = await loginWithPassword(email, "enroll-test-password");
    await expect(startMfaEnrollment(again!.token)).rejects.toMatchObject({ status: 409 });
  });

  it("two people enrolling the same account at once: the first confirmation wins, the other cannot overwrite it", async () => {
    const email = "enroll-race@sample-practice.test";
    await freshUser(email);
    const a = await loginWithPassword(email, "enroll-test-password");
    const b = await loginWithPassword(email, "enroll-test-password");
    const ea = await startMfaEnrollment(a!.token);
    const eb = await startMfaEnrollment(b!.token);
    expect(ea!.secret).not.toBe(eb!.secret);
    // B starting later does not break A's pending setup.
    expect(await confirmMfaEnrollment(a!.token, authenticator.generate(ea!.secret))).not.toBeNull();
    await expect(confirmMfaEnrollment(b!.token, authenticator.generate(eb!.secret))).rejects.toMatchObject({
      status: 409,
    });
    const user = await db().user.findUniqueOrThrow({ where: { email } });
    expect(user.totpSecret).toBe(ea!.secret);
  });

  it("ends the sign-in after five wrong codes, and locks the account after ten", async () => {
    const email = "enroll-limit@sample-practice.test";
    await freshUser(email);
    const first = await loginWithPassword(email, "enroll-test-password");
    const en = await startMfaEnrollment(first!.token);
    await confirmMfaEnrollment(first!.token, authenticator.generate(en!.secret));
    const wrong = authenticator.generate(en!.secret) === "123456" ? "654321" : "123456";
    const { verifyMfa, MAX_MFA_ATTEMPTS_PER_SESSION } = await import("@/lib/auth/session");
    const s1 = await loginWithPassword(email, "enroll-test-password");
    for (let i = 0; i < MAX_MFA_ATTEMPTS_PER_SESSION; i++)
      expect(await verifyMfa(s1!.token, wrong)).toBeNull();
    expect(await getSessionByToken(s1!.token, { allowUnverified: true })).toBeNull();
    const s2 = await loginWithPassword(email, "enroll-test-password");
    for (let i = 0; i < MAX_MFA_ATTEMPTS_PER_SESSION; i++)
      expect(await verifyMfa(s2!.token, wrong)).toBeNull();
    // Ten consecutive failures: even the right code is refused for a while.
    const s3 = await loginWithPassword(email, "enroll-test-password");
    await expect(verifyMfa(s3!.token, authenticator.generate(en!.secret))).rejects.toMatchObject({
      status: 429,
    });
    await db().user.update({ where: { email }, data: { mfaLockedUntil: null } });
    expect(await verifyMfa(s3!.token, authenticator.generate(en!.secret))).not.toBeNull();
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
