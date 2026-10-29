/**
 * Loads the synthetic dataset. Idempotent: each fictional org's rows are
 * deleted and re-created with deterministic IDs. Synthetic data only.
 */
import { Prisma, PrismaClient } from "@prisma/client";
import { hashPassword } from "../../src/lib/auth/local";
import { withOrg, type Tx } from "../../src/lib/db";
import { toDay, type Day } from "../../src/lib/dates";
import { loadGoalBank } from "../../src/lib/goals/bank";
import { masteryDefaults, tokenizeMastery } from "../../src/lib/goals/tokenize";
import { loadPayorSeed, resolvePayorRules } from "../../src/lib/payors/load";
import { buildDataset, sid, type SynOrg } from "./dataset";

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
  "intake",
  "service_session",
  "authorization_unit",
  "authorization",
  "attachment",
  "client_payor",
  "diagnosis",
  "client",
  "goal_template",
  "payor_rule",
  "payor_document",
  "payor",
  "membership",
];

/** seededAsOf marks the dataset date; it commits with the org's data, so it also marks a completed seed. */
export async function seedOrg(org: SynOrg, asOf: Day) {
  const ctx = { orgId: org.id, userId: null, role: null };
  const prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  // Hosted demo: the password comes from the host's settings (never the one in this repo),
  // and each user sets up their own authenticator on first sign-in.
  const demo = process.env.DEMO_MODE === "true";
  const demoPassword = process.env.DEMO_PASSWORD ?? "";
  if (demo && demoPassword.length < 12)
    throw new Error("DEMO_PASSWORD (12+ characters) is required in demo mode");
  const creds = (u: SynOrg["users"][number]) => ({
    passwordHash: hashPassword(demo ? demoPassword : u.password),
    totpSecret: demo ? null : u.totpSecret,
    mfaEnabled: !demo,
  });
  // Users are global identity rows (no RLS): upsert with the demo credentials.
  for (const u of org.users) {
    await prisma.user.upsert({
      where: { email: u.email },
      create: { id: u.id, email: u.email, name: u.name, ...creds(u) },
      update: { name: u.name, ...creds(u) },
    });
    await prisma.authSession.deleteMany({ where: { userId: u.id } });
  }
  await prisma.$disconnect();

  await withOrg(ctx, async (tx) => {
    for (const t of ORG_TABLES)
      await tx.$executeRawUnsafe(`DELETE FROM "${t}" WHERE org_id = $1::uuid`, org.id);
    await tx.org.upsert({
      where: { id: org.id },
      create: {
        id: org.id,
        name: org.name,
        settings: { ...org.settings, seededAsOf: asOf } as Prisma.InputJsonValue,
      },
      update: { name: org.name, settings: { ...org.settings, seededAsOf: asOf } as Prisma.InputJsonValue },
    });
    await tx.membership.createMany({
      data: org.users.map((u) => ({
        id: sid(`membership:${org.id}:${u.id}`),
        orgId: org.id,
        userId: u.id,
        role: u.role,
      })),
    });
    const payorIds = await seedPayors(tx, org.id);
    await seedGoalTemplates(tx, org.id);
    for (const c of org.clients) await seedClient(tx, org.id, c, payorIds);
  });
}

async function seedPayors(tx: Tx, orgId: string) {
  const seed = loadPayorSeed();
  const docIds: Record<string, string> = {};
  for (const [key, doc] of Object.entries(seed.documents)) {
    docIds[key] = sid(`${orgId}:doc:${key}`);
    await tx.payorDocument.create({
      data: {
        id: docIds[key]!,
        orgId,
        key,
        name: doc.name,
        version: doc.version,
        url: doc.url,
        effectiveDate: doc.effective_date ? d(doc.effective_date) : null,
      },
    });
  }
  const payorIds: Record<string, string> = {};
  for (const p of seed.payors) {
    payorIds[p.id] = sid(`${orgId}:payor:${p.id}`);
    await tx.payor.create({
      data: { id: payorIds[p.id]!, orgId, key: p.id, name: p.name, inherits: p.inherits ?? null },
    });
  }
  for (const p of seed.payors) {
    const rules = resolvePayorRules(seed, p.id);
    await tx.payorRule.createMany({
      data: rules.map((r, i) => ({
        id: sid(`${orgId}:rule:${p.id}:${i}`),
        orgId,
        payorId: payorIds[p.id]!,
        type: r.type,
        params: r.params as Prisma.InputJsonValue,
        sourceDocumentId: r.source.key ? (docIds[r.source.key] ?? null) : null,
        sourceSection: r.source.section,
        verified: r.verified,
        notes: r.notes,
        inheritedFrom: r.inheritedFrom,
        ordinal: i,
      })),
    });
  }
  return payorIds;
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
      secondaryDocsSigned: p.secondaryDocsSigned ?? false,
    })),
  });
  if (c.attachments.length)
    await tx.attachment.createMany({
      data: c.attachments.map((a) => ({ ...a, orgId, clientId: c.id, documentDate: d(a.documentDate) })),
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
      const users = ds.orgs.flatMap((o) => o.users);
      console.log(
        `Seeded ${ds.orgs.length} synthetic orgs, ${ds.orgs.reduce((n, o) => n + o.clients.length, 0)} synthetic clients (asOf ${ds.asOf}).`,
      );
      console.log(
        process.env.DEMO_MODE === "true"
          ? "Demo logins (password: DEMO_PASSWORD; each person sets up an authenticator app at first sign-in):"
          : "Demo logins (synthetic only; password for all: synthetic-demo-only). Get a TOTP code with: pnpm totp <email>",
      );
      for (const u of users) console.log(`  ${u.role.padEnd(16)} ${u.email}`);
      process.exit(0);
    })
    .catch((e) => {
      console.error("Seed failed:", e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
