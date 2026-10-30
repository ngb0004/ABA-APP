/**
 * Loads the synthetic dataset. Idempotent: each fictional org's rows are
 * deleted and re-created with deterministic IDs. Synthetic data only.
 */
import { Prisma, PrismaClient } from "@prisma/client";
import { setPlatformCurator } from "../../src/lib/auth/curator";
import { hashPassword } from "../../src/lib/auth/local";
import { withOrg, type Tx } from "../../src/lib/db";
import { addMonths, toDay, type Day } from "../../src/lib/dates";
import { baseline, BASELINE_POINTS } from "../../src/lib/plan/progress";
import { loadGoalBank } from "../../src/lib/goals/bank";
import { masteryDefaults, tokenizeMastery } from "../../src/lib/goals/tokenize";
import { syncPayorLibrary } from "../../src/lib/payors/library";
import { assessmentCatalog } from "../../src/lib/assessments/catalog";
import { validateAssessment } from "../../src/lib/assessments/validate";
import { buildDataset, SEED_VERSION, sid, type SynOrg } from "./dataset";

const d = (day: Day) => new Date(`${day}T00:00:00Z`);

/** Org-scoped tables in delete order (children first). */
const ORG_TABLES = [
  "packet",
  "payor_letter",
  "plan_section_revision",
  "plan_section",
  "goal_phase_change",
  "goal_data_point",
  "goal",
  "plan",
  "milestone_score",
  "vbmapp_administration",
  "vbmapp_import",
  "assessment_score",
  "assessment",
  "intake",
  "service_session",
  "authorization_unit",
  "authorization",
  "attachment",
  "benefits_check",
  "client_payor",
  "diagnosis",
  "client",
  "goal_template",
];

/**
 * The synthetic curator gets the platform flag the same way staff do: setPlatformCurator() over the
 * owner connection (the database rejects the app role changing it). Audit-logged like any grant.
 */
async function seedCurators(org: SynOrg) {
  const curators = org.users.filter((u) => u.platformCurator);
  if (!curators.length) return;
  const url = process.env.DIRECT_DATABASE_URL;
  if (!url) {
    console.warn("DIRECT_DATABASE_URL is not set: the synthetic curator account is not a curator.");
    return;
  }
  const owner = new PrismaClient({ datasourceUrl: url, errorFormat: "minimal" });
  try {
    for (const u of curators) await setPlatformCurator(owner, u.email, true, "seed");
  } finally {
    await owner.$disconnect();
  }
}

/** seededAsOf marks the dataset date; it commits with the org's data, so it also marks a completed seed. */
export async function seedOrg(fullOrg: SynOrg, asOf: Day) {
  const ctx = { orgId: fullOrg.id, userId: null, role: null };
  const prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  // Hosted demo: the password comes from the host's settings (never the one in this repo),
  // and each user sets up their own authenticator on first sign-in.
  const demo = process.env.DEMO_MODE === "true";
  const demoPassword = process.env.DEMO_PASSWORD ?? "";
  if (demo && demoPassword.length < 12)
    throw new Error("DEMO_PASSWORD (12+ characters) is required in demo mode");
  // The hosted demo has no rule curator: a shared password must never verify payor rules.
  const org = demo ? { ...fullOrg, users: fullOrg.users.filter((u) => !u.platformCurator) } : fullOrg;
  const creds = (u: SynOrg["users"][number]) => ({
    passwordHash: hashPassword(demo ? demoPassword : u.password),
    totpSecret: demo ? null : u.totpSecret,
    mfaEnabled: !demo,
  });
  // On the demo, a reload keeps the authenticators people already set up (only new accounts start without one).
  const keepMfa = (c: ReturnType<typeof creds>) => ({ passwordHash: c.passwordHash });

  // Users are global identity rows (no RLS): upsert with the demo credentials.
  for (const u of org.users) {
    await prisma.user.upsert({
      where: { email: u.email },
      create: { id: u.id, email: u.email, name: u.name, ...creds(u) },
      update: { name: u.name, ...(demo ? keepMfa(creds(u)) : creds(u)) },
    });
    await prisma.authSession.deleteMany({ where: { userId: u.id } });
  }
  // Everyone signed in to this practice signs in again after a reload (including people added in Settings).
  await prisma.authSession.deleteMany({ where: { orgId: org.id } });
  await prisma.$disconnect();
  await seedCurators(org);

  await withOrg(ctx, async (tx) => {
    for (const t of ORG_TABLES)
      await tx.$executeRawUnsafe(`DELETE FROM "${t}" WHERE org_id = $1::uuid`, org.id);
    await tx.org.upsert({
      where: { id: org.id },
      create: {
        id: org.id,
        name: org.name,
        settings: { ...org.settings, seededAsOf: asOf, seedVersion: SEED_VERSION } as Prisma.InputJsonValue,
      },
      update: {
        name: org.name,
        settings: { ...org.settings, seededAsOf: asOf, seedVersion: SEED_VERSION } as Prisma.InputJsonValue,
      },
    });
    // Dataset users get their dataset roles back; team members someone added in Settings stay.
    await tx.membership.deleteMany({ where: { orgId: org.id, userId: { in: org.users.map((u) => u.id) } } });
    await tx.membership.createMany({
      data: org.users.map((u) => ({
        id: sid(`membership:${org.id}:${u.id}`),
        orgId: org.id,
        userId: u.id,
        role: u.role,
      })),
    });
    // Payors, documents and rules are synced (not recreated), so evidence and snapshots survive a reseed.
    const { payorIds } = await syncPayorLibrary(tx, org.id);
    await seedGoalTemplates(tx, org.id);
    for (const c of org.clients) await seedClient(tx, org.id, c, payorIds, asOf);
  });
}

async function seedGoalTemplates(tx: Tx, orgId: string) {
  const bank = loadGoalBank();
  await tx.goalTemplate.createMany({
    data: bank.map((t) => ({
      id: sid(`${orgId}:tpl:${t.domainNumber}:${t.tier}`),
      orgId,
      domainNumber: t.domainNumber,
      domainName: t.domainName,
      tier: t.tier,
      tierName: t.tierName,
      category: t.category,
      goalText: t.goalText,
      rationalePattern: t.rationalePattern,
      rationaleText: t.rationaleText,
      linkedMilestones: t.linkedMilestones as Prisma.InputJsonValue,
    })),
  });
}

async function seedClient(
  tx: Tx,
  orgId: string,
  c: SynOrg["clients"][number],
  payorIds: Record<string, string>,
  asOf: Day,
) {
  await tx.client.create({
    data: {
      id: c.id,
      orgId,
      isSynthetic: true,
      firstName: c.firstName,
      lastName: c.lastName,
      preferredName: c.preferredName,
      dob: d(c.dob),
      sex: c.sex,
      serviceAddress: c.serviceAddress,
      guardians: c.guardians,
      hasIep: c.hasIep,
      events: c.events,
    },
  });
  await tx.diagnosis.createMany({
    data: c.diagnoses.map((x) => ({ ...x, orgId, clientId: c.id, evaluationDate: d(x.evaluationDate) })),
  });
  await tx.clientPayor.createMany({
    data: c.payors.map((p) => ({
      id: p.id,
      orgId,
      clientId: c.id,
      payorId: payorIds[p.payorKey]!,
      priority: p.priority,
      memberId: p.memberId,
      planName: p.planName,
      planType: p.planType,
      planState: p.planState,
      secondaryDocsSigned: p.secondaryDocsSigned ?? false,
    })),
  });
  if (c.attachments.length)
    await tx.attachment.createMany({
      data: c.attachments.map((a) => ({ ...a, orgId, clientId: c.id, documentDate: d(a.documentDate) })),
    });
  if (c.benefitsChecks.length)
    await tx.benefitsCheck.createMany({
      data: c.benefitsChecks.map((b) => ({
        ...b,
        orgId,
        clientId: c.id,
        payorId: payorIds[c.payors.find((p) => p.id === b.clientPayorId)!.payorKey]!,
        checkedOn: d(b.checkedOn),
      })),
    });
  const a = c.authorization;
  await tx.authorization.create({
    data: {
      id: a.id,
      orgId,
      clientId: c.id,
      payorId: payorIds[a.payorKey]!,
      authNumber: a.authNumber,
      kind: a.kind,
      startDate: d(a.startDate),
      endDate: d(a.endDate),
      recommendedHoursPerWeek: a.recommendedHoursPerWeek,
    },
  });
  await tx.authorizationUnit.createMany({
    data: a.units.map((u, i) => ({ id: sid(`${a.id}:unit:${i}`), orgId, authorizationId: a.id, ...u })),
  });
  if (c.sessions.length)
    await tx.serviceSession.createMany({
      data: c.sessions.map((s) => ({ ...s, orgId, clientId: c.id, authorizationId: a.id, date: d(s.date) })),
    });
  await tx.intake.create({
    data: {
      id: sid(`${c.id}:intake`),
      orgId,
      clientId: c.id,
      answers: c.intake as Prisma.InputJsonValue,
      status: "submitted",
      submittedAt: new Date(),
    },
  });
  for (const adm of c.administrations) {
    const levels: Record<number, number> = { 1: 0, 2: 0, 3: 0 };
    const domains: Record<string, number> = {};
    for (const s of adm.scores) {
      levels[s.level] = (levels[s.level] ?? 0) + s.score;
      domains[`L${s.level}.${s.domain}`] = (domains[`L${s.level}.${s.domain}`] ?? 0) + s.score;
    }
    const totals = { total: levels[1]! + levels[2]! + levels[3]!, levels, domains };
    await tx.vbmappAdministration.create({
      data: {
        id: adm.id,
        orgId,
        clientId: c.id,
        adminNumber: adm.adminNumber,
        testDate: d(adm.testDate),
        testerInitials: adm.testerInitials,
        totals,
        flags: [],
        verified: true,
        reviewerId: sid("user:bcba"),
        reviewedAt: new Date(),
      },
    });
    await tx.milestoneScore.createMany({
      data: adm.scores.map((s, i) => ({
        id: sid(`${adm.id}:s:${i}`),
        orgId,
        administrationId: adm.id,
        ...s,
      })),
    });
  }
  // Assessments go through the same catalog validation as the entry form.
  for (const a of c.assessments) {
    let v: ReturnType<typeof validateAssessment>;
    try {
      v = validateAssessment(assessmentCatalog(), { ...a, notes: null }, asOf);
    } catch (e) {
      // Synthetic data only, so the problems are safe to print.
      const issues = (e as { issues?: string[] }).issues ?? [];
      throw new Error(
        `Synthetic assessment ${a.id} is invalid: ${issues.join("; ") || (e as Error).message}`,
      );
    }
    await tx.assessment.create({
      data: {
        id: a.id,
        orgId,
        clientId: c.id,
        typeKey: v.typeKey,
        module: v.module,
        form: v.form,
        respondent: v.respondent,
        customName: v.customName,
        administeredOn: d(v.administeredOn),
        administeredBy: v.administeredBy,
        source: "manual",
        status: a.status,
        ...(a.status === "confirmed" ? { reviewerId: sid("user:bcba"), reviewedAt: new Date() } : {}),
        createdById: sid("user:bcba"),
      },
    });
    await tx.assessmentScore.createMany({
      data: v.scores.map((s) => ({
        id: sid(`${a.id}:score:${s.scaleKey}`),
        orgId,
        assessmentId: a.id,
        ...s,
      })),
    });
  }
  const primaryDx = c.diagnoses.find((x) => x.isPrimary) ?? c.diagnoses[0]!;
  for (const goal of c.goals) {
    const dx = c.diagnoses.find((x) => x.deficitAreas.includes(goal.deficitArea)) ?? primaryDx;
    await tx.goal.create({
      data: {
        id: goal.id,
        orgId,
        clientId: c.id,
        diagnosisId: dx.id,
        ordinal: goal.ordinal,
        domain: goal.domain,
        tier: goal.tier,
        category: goal.category,
        measure: goal.measure,
        deficitArea: goal.deficitArea,
        linkedMilestones: goal.linkedMilestones,
        initiationWindow: goal.initiationWindow,
        objective: tokenizeMastery(goal.objective, goal.ordinal),
        ...masteryDefaults(goal.objective),
        rationalePattern: goal.rationalePattern,
        rationale: goal.rationale,
        baselineSource: { kind: "datapoints", window: "first_3" },
        ...goalRecord(goal.dataPoints),
        replacementForGoalId: goal.replacementFor
          ? c.goals.find((x) => x.ordinal === goal.replacementFor)!.id
          : null,
        dataCollection:
          goal.measure === "frequency"
            ? "Frequency per session, event recording"
            : "Percent correct, minimum 10 trials per session, prompt level recorded per trial",
        prompting:
          goal.measure === "frequency"
            ? ""
            : "Most-to-least prompting with a progressive time delay; transfer trials after prompted responses",
        teachingProcedure:
          goal.measure === "frequency"
            ? "Function-based intervention per the behavior intervention plan"
            : "DTT and NET with differential reinforcement and error correction",
      },
    });
    await tx.goalDataPoint.createMany({
      data: goal.dataPoints.map((p, i) => ({
        id: sid(`${goal.id}:dp:${i}`),
        orgId,
        goalId: goal.id,
        date: d(p.date),
        value: p.value,
        trials: p.trials,
      })),
    });
    if (goal.phaseChanges.length)
      await tx.goalPhaseChange.createMany({
        data: goal.phaseChanges.map((p, i) => ({
          id: sid(`${goal.id}:pc:${i}`),
          orgId,
          goalId: goal.id,
          date: d(p.date),
          label: p.label,
        })),
      });
  }
}

/** Dates, status, and a locked baseline, all taken from the goal's own synthetic data. */
function goalRecord(points: { date: Day; value: number }[]) {
  const sorted = [...points].sort((x, y) => x.date.localeCompare(y.date));
  const first = sorted[0];
  const third = sorted[BASELINE_POINTS - 1];
  const bl = baseline(sorted);
  return {
    progressStatus: first ? "in_progress" : "new",
    introducedAt: first ? d(first.date) : null,
    projectedMasteryDate: first ? d(addMonths(first.date, 6)) : null,
    settings: ["home"],
    ...(third && bl !== null
      ? { baselineValue: bl, baselineDate: d(third.date), baselineLockedAt: d(third.date) }
      : {}),
  };
}

export async function seedAll(asOf: Day = toDay(new Date())) {
  const ds = buildDataset(asOf);
  for (const org of ds.orgs) {
    // Rule 1: refuse anything that does not look synthetic.
    for (const c of org.clients)
      if (!c.payors.every((p) => p.memberId.startsWith("SYN-")))
        throw new Error("Refusing to seed: non-synthetic member ID");
    await seedOrg(org, ds.asOf);
  }
  return ds;
}

if (process.argv[1] && /seed\/synthetic\/index\.ts$/.test(process.argv[1])) {
  seedAll()
    .then((ds) => {
      const users = ds.orgs
        .flatMap((o) => o.users)
        .filter((u) => process.env.DEMO_MODE !== "true" || !u.platformCurator);
      console.log(
        `Seeded ${ds.orgs.length} synthetic orgs, ${ds.orgs.reduce((n, o) => n + o.clients.length, 0)} synthetic clients (asOf ${ds.asOf}).`,
      );
      console.log(
        process.env.DEMO_MODE === "true"
          ? "Demo logins (password: DEMO_PASSWORD; each person sets up an authenticator app at first sign-in):"
          : "Demo logins (synthetic only; password for all: synthetic-demo-only). Get a TOTP code with: pnpm totp <email>",
      );
      for (const u of users)
        console.log(`  ${u.role.padEnd(16)} ${u.email}${u.platformCurator ? " (platform curator)" : ""}`);
      process.exit(0);
    })
    .catch((e) => {
      console.error("Seed failed:", e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
