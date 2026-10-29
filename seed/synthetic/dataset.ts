/**
 * Synthetic dataset: one fictional practice ("Sample Practice, Peachtree City GA"),
 * three fictional clients, and a second fictional org used for isolation tests.
 * Every name is obviously fake, every member ID starts with "SYN-", and every
 * client has is_synthetic = true. Deterministic for a given asOf date.
 */
import { createHash } from "node:crypto";
import { addDays, addMonths, diffDays, weekday, type Day } from "../../src/lib/dates";
import type { IntakeAnswers } from "../../src/lib/intake/schema";

// ---------------------------------------------------------------- helpers

/** Deterministic UUID (v5-shaped) from a name, so reseeding produces identical IDs. */
export function sid(name: string): string {
  const h = createHash("sha1").update(`aba-synthetic:${name}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const round1 = (n: number) => Math.round(n * 10) / 10;

// ---------------------------------------------------------------- types

export type SynUser = {
  id: string;
  email: string;
  name: string;
  password: string;
  totpSecret: string;
  role: "BCBA" | "BCaBA" | "RBT" | "AUTH_COORDINATOR" | "PARENT";
};
export type SynSession = {
  id: string;
  cptCode: string;
  date: Day;
  startMinute: number;
  units: number;
  providerRole: "BCBA" | "RBT" | "BCaBA";
  providerId: string;
  inPerson: boolean;
};
export type SynScore = {
  level: number;
  domain: string;
  milestone: number;
  score: 0.5 | 1;
  firstAdmin: number;
};
export type SynAdmin = {
  id: string;
  adminNumber: number;
  testDate: Day;
  testerInitials: string;
  scores: SynScore[];
};
export type SynGoal = {
  id: string;
  ordinal: number;
  domainNumber: number;
  tier: number;
  domain: string;
  category: string;
  measure: "percent" | "frequency" | "duration";
  deficitArea: string;
  objective: string;
  rationalePattern: "A" | "B";
  rationale: string;
  linkedMilestones: { level: number; domain: string; from: number; to: number }[];
  initiationWindow: string;
  replacementFor?: number;
  dataPoints: { date: Day; value: number; trials: number | null }[];
  phaseChanges: { date: Day; label: string }[];
};
export type SynClient = {
  id: string;
  key: "client1" | "client2" | "client3" | "other1";
  firstName: string;
  lastName: string;
  preferredName: string;
  dob: Day;
  sex: string;
  serviceAddress: { line1: string; city: string; state: string; zip: string };
  guardians: { name: string; relationship: string; legalCustody: boolean }[];
  hasIep: boolean;
  events: string[];
  diagnoses: {
    id: string;
    dsm5Code: string;
    dsm5Label: string;
    icd10Code: string;
    isPrimary: boolean;
    severity: string;
    evaluationDate: Day;
    deficitAreas: string[];
  }[];
  payors: {
    id: string;
    payorKey: string;
    priority: "primary" | "secondary";
    memberId: string;
    planName: string;
    secondaryDocsSigned?: boolean;
  }[];
  attachments: { id: string; kind: string; title: string; documentDate: Day; caregiverSigned: boolean }[];
  authorization: {
    id: string;
    payorKey: string;
    authNumber: string;
    kind: "initial" | "reauth";
    startDate: Day;
    endDate: Day;
    recommendedHoursPerWeek: number;
    units: { cptCode: string; approvedUnits: number; unitBasis: "week" | "month" | "auth" }[];
  };
  sessions: SynSession[];
  intake: IntakeAnswers;
  administrations: SynAdmin[];
  goals: SynGoal[];
};
export type SynOrg = {
  id: string;
  name: string;
  settings: Record<string, unknown>;
  users: SynUser[];
  clients: SynClient[];
};
export type SynDataset = { asOf: Day; orgs: SynOrg[] };

// ---------------------------------------------------------------- builders

const L1 = ["Mand", "Tact", "Listener", "VP/MTS", "Play", "Social", "Imitation", "Echoic", "Vocal"];
const L2 = [
  "Mand",
  "Tact",
  "Listener",
  "VP/MTS",
  "Play",
  "Social",
  "Imitation",
  "Echoic",
  "LRFFC",
  "IV",
  "Group",
  "Linguistics",
];
const LEVEL_BASE: Record<number, number> = { 1: 1, 2: 6, 3: 11 };

/** profile: level → domain → points scored (0-5, halves allowed), filled from the bottom milestone up. */
function scoresFrom(profile: Record<number, Record<string, number>>, firstAdmin: number): SynScore[] {
  const out: SynScore[] = [];
  for (const [lvl, domains] of Object.entries(profile)) {
    const level = Number(lvl);
    for (const [domain, pts] of Object.entries(domains)) {
      const full = Math.floor(pts);
      for (let i = 0; i < full; i++)
        out.push({ level, domain, milestone: LEVEL_BASE[level]! + i, score: 1, firstAdmin });
      if (pts - full >= 0.5)
        out.push({ level, domain, milestone: LEVEL_BASE[level]! + full, score: 0.5, firstAdmin });
    }
  }
  return out;
}

/** Cumulative admin k scores: a milestone keeps the earliest admin in which it scored. */
function cumulative(prev: SynScore[], next: SynScore[]): SynScore[] {
  return next.map((s) => {
    const p = prev.find((x) => x.level === s.level && x.domain === s.domain && x.milestone === s.milestone);
    return p ? { ...s, firstAdmin: p.firstAdmin } : s;
  });
}

const all = (names: string[], v: number) => Object.fromEntries(names.map((n) => [n, v]));

function sessionsFor(
  key: string,
  start: Day,
  end: Day,
  asOf: Day,
  plan: (d: Day, dow: number, week: number, r: () => number) => Omit<SynSession, "id" | "date">[],
): SynSession[] {
  const r = rng(parseInt(createHash("md5").update(key).digest("hex").slice(0, 8), 16));
  const out: SynSession[] = [];
  const last = asOf < end ? addDays(asOf, -1) : end;
  for (let d = start, i = 0; d <= last; d = addDays(d, 1), i++) {
    const week = Math.floor(diffDays(d, start) / 7);
    plan(d, weekday(d), week, r).forEach((s, j) => out.push({ ...s, date: d, id: sid(`${key}:${d}:${j}`) }));
  }
  return out;
}

/** Goal data: three probes a week over 26 weeks, following shape(weekIndex) with deterministic noise. */
function goalData(
  key: string,
  asOf: Day,
  shape: (w: number) => number | null,
  opts: { measure?: "percent" | "frequency"; noise?: number; skipWeeks?: number[]; sparse?: boolean } = {},
) {
  const r = rng(parseInt(createHash("md5").update(key).digest("hex").slice(0, 8), 16));
  const start = addDays(asOf, -26 * 7);
  const pts: { date: Day; value: number; trials: number | null }[] = [];
  for (let w = 0; w < 26; w++) {
    if (opts.skipWeeks?.includes(w)) continue;
    for (const off of opts.sparse ? [1] : [0, 2, 4]) {
      const date = addDays(start, w * 7 + off);
      if (date >= asOf) continue;
      const base = shape(w);
      if (base === null) continue;
      const noisy = base + (r() - 0.5) * 2 * (opts.noise ?? 4);
      pts.push(
        opts.measure === "frequency"
          ? { date, value: Math.max(0, round1(noisy)), trials: null }
          : { date, value: Math.round(clamp(noisy, 0, 100)), trials: 10 },
      );
    }
  }
  return pts;
}

const lin =
  (a: number, b: number, from = 0, to = 25) =>
  (w: number) =>
    w <= from ? a : w >= to ? b : a + ((b - a) * (w - from)) / (to - from);

function g(
  partial: Omit<SynGoal, "id" | "linkedMilestones" | "initiationWindow" | "phaseChanges"> &
    Partial<Pick<SynGoal, "linkedMilestones" | "initiationWindow" | "phaseChanges">>,
  clientKey: string,
): SynGoal {
  return {
    linkedMilestones: [],
    initiationWindow: "Months 1-3",
    phaseChanges: [],
    ...partial,
    id: sid(`${clientKey}:goal:${partial.ordinal}`),
  };
}

// ---------------------------------------------------------------- intake

function intakeBase(over: Partial<IntakeAnswers>): IntakeAnswers {
  const base: IntakeAnswers = {
    primary_concerns: { value: "Limited functional communication and difficulty with transitions." },
    diagnosis_date: { na: true },
    diagnosing_provider_type: { value: "Developmental pediatrician" },
    medications: { na: true },
    severe_allergy: { value: false },
    epipen: { value: false },
    inhaler: { value: false },
    seizures: { value: false },
    sleep_difficulty: { value: "sometimes" },
    feeding_concerns: { value: false },
    toileting_status: { value: "Trained with occasional accidents" },
    communication_modes: { value: ["Vocal words"] },
    aggression: { na: true },
    aggression_frequency: { na: true },
    self_injury: { na: true },
    tantrums: { value: { count: 3, per: "day", durationMinutes: 5 } },
    transitions_difficulty: { value: "often" },
    bolting: { value: false },
    overnight_wandering: { value: false },
    pica: { value: false },
    transportation_risks: { na: true },
    school_placement: { value: "Not enrolled" },
    has_iep: { value: false },
    prior_evaluations: { na: true },
    other_therapies: { na: true },
    abuse_history: { value: false },
    suicidal_behavior: { value: false },
    family_psychiatric_history: { value: false },
    custody_arrangement: { value: "Joint legal custody" },
    caregiver_priorities: { value: "Communicate wants and needs, and follow routines at home." },
    caregiver_training_availability: { value: true },
    availability: {
      value: {
        Mon: [0, 1, 2, 3, 4],
        Tue: [0, 1, 2, 3, 4],
        Wed: [0, 1, 2, 3, 4],
        Thu: [0, 1, 2, 3, 4],
        Fri: [0, 1, 2, 3, 4],
      },
    },
  };
  return { ...base, ...over } as IntakeAnswers;
}

// ---------------------------------------------------------------- dataset

export const DEMO_PASSWORD = "synthetic-demo-only";

export function buildDataset(asOf: Day): SynDataset {
  const orgId = sid("org:sample-practice");
  const otherOrgId = sid("org:other-sample-practice");

  const users: SynUser[] = [
    {
      id: sid("user:bcba"),
      email: "bcba@sample-practice.test",
      name: "Avery Sample, BCBA",
      password: DEMO_PASSWORD,
      totpSecret: "KVKFKRCPNZQUYMLXOVYDSQKJKZDTSRLD",
      role: "BCBA",
    },
    {
      id: sid("user:rbt"),
      email: "rbt@sample-practice.test",
      name: "Riley Sample, RBT",
      password: DEMO_PASSWORD,
      totpSecret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
      role: "RBT",
    },
    {
      id: sid("user:coord"),
      email: "coordinator@sample-practice.test",
      name: "Casey Sample",
      password: DEMO_PASSWORD,
      totpSecret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
      role: "AUTH_COORDINATOR",
    },
    {
      id: sid("user:parent"),
      email: "parent@sample-practice.test",
      name: "Pat Testparent",
      password: DEMO_PASSWORD,
      totpSecret: "MFRGGZDFMZTWQ2LKNNWG23TPOBYXE43U",
      role: "PARENT",
    },
  ];

  // ----- Client 1: early learner, VB-MAPP Level 1, GA Medicaid (Amerigroup), initial assessment
  const c1Start = addDays(asOf, -30);
  const c1End = addDays(c1Start, 90);
  const c1: SynClient = {
    id: sid("client:1"),
    key: "client1",
    firstName: "Alpha",
    lastName: "Testchild",
    preferredName: "Alpha",
    dob: addMonths(asOf, -38),
    sex: "F",
    serviceAddress: { line1: "1 Fictional Lane", city: "Peachtree City", state: "GA", zip: "30269" },
    guardians: [
      { name: "Pat Testparent", relationship: "Mother", legalCustody: true },
      { name: "Sam Testparent", relationship: "Father", legalCustody: true },
    ],
    hasIep: false,
    events: [],
    diagnoses: [
      {
        id: sid("c1:dx"),
        dsm5Code: "299.00",
        dsm5Label: "Autism spectrum disorder, requiring substantial support (Level 2)",
        icd10Code: "F84.0",
        isPrimary: true,
        severity: "Level 2",
        evaluationDate: addDays(asOf, -75),
        deficitAreas: ["communication", "social_interaction", "restricted_repetitive_behavior", "adaptive"],
      },
    ],
    payors: [
      {
        id: sid("c1:payor"),
        payorKey: "amerigroup",
        priority: "primary",
        memberId: "SYN-AMG-000101",
        planName: "Amerigroup Georgia Medicaid (synthetic)",
      },
    ],
    attachments: [
      {
        id: sid("c1:att:dx"),
        kind: "diagnostic_evaluation",
        title: "Diagnostic evaluation",
        documentDate: addDays(asOf, -75),
        caregiverSigned: true,
      },
      {
        id: sid("c1:att:ei"),
        kind: "prior_evaluation",
        title: "Early intervention evaluation",
        documentDate: addDays(asOf, -200),
        caregiverSigned: true,
      },
      {
        id: sid("c1:att:lmn"),
        kind: "other",
        title: "Letter of medical necessity",
        documentDate: addDays(asOf, -70),
        caregiverSigned: false,
      },
    ],
    authorization: {
      id: sid("c1:auth"),
      payorKey: "amerigroup",
      authNumber: "SYN-AUTH-1001",
      kind: "initial",
      startDate: c1Start,
      endDate: c1End,
      recommendedHoursPerWeek: 25,
      units: [{ cptCode: "97151", approvedUnits: 32, unitBasis: "auth" }],
    },
    sessions: sessionsFor("c1", c1Start, c1End, asOf, (d, dow, week) =>
      dow === 2 && week < 4
        ? [
            {
              cptCode: "97151",
              startMinute: 540,
              units: 6,
              providerRole: "BCBA",
              providerId: "BCBA-1",
              inPerson: true,
            },
          ]
        : [],
    ),
    intake: intakeBase({
      primary_concerns: {
        value: "Few words; leads adults by the hand to get items; cries during transitions.",
      },
      severe_allergy: { value: true, comment: "Peanut" },
      epipen: { value: true, comment: "Kept in the diaper bag" },
      communication_modes: { value: ["Vocal approximations", "Leading adults", "Crying or gestures"] },
      toileting_status: { value: "Not toilet trained" },
      prior_evaluations: {
        value: [
          {
            type: "Early intervention evaluation",
            provider: "County early intervention program (synthetic)",
            date: addDays(asOf, -200),
          },
        ],
      },
      school_placement: { value: "Home with caregiver" },
      availability: {
        value: { Mon: [0, 1, 2], Tue: [0, 1, 2], Wed: [0, 1, 2], Thu: [0, 1, 2], Fri: [0, 1, 2] },
      },
    }),
    administrations: [
      {
        id: sid("c1:vb:1"),
        adminNumber: 1,
        testDate: addDays(asOf, -24),
        testerInitials: "AS",
        scores: scoresFrom(
          {
            1: {
              Mand: 2,
              Tact: 1.5,
              Listener: 2,
              "VP/MTS": 3,
              Play: 2.5,
              Social: 1,
              Imitation: 2,
              Echoic: 1.5,
              Vocal: 3,
            },
          },
          1,
        ),
      },
    ],
    goals: [],
  };
  c1.goals = [
    g(
      {
        ordinal: 1,
        domainNumber: 1,
        tier: 1,
        domain: "Manding (Requesting)",
        category: "communication",
        measure: "percent",
        deficitArea: "communication",
        objective:
          "[Client] will independently mand for a preferred item or activity using vocal approximations when the item is visible and a motivating operation is present, across a minimum of ten distinct targets in 80% of opportunities with accuracy and independence across 5 consecutive sessions with 2 people within the six-month authorization period.",
        rationalePattern: "A",
        rationale:
          "This goal targets independent requesting so that [Client] can access preferred items directly rather than by leading adults or crying. Baseline data show independent mands in {{goal.1.baseline_pct}} of opportunities. An independent mand repertoire reduces reliance on caregiver interpretation and generalizes across people and settings.",
        linkedMilestones: [{ level: 1, domain: "Mand", from: 3, to: 4 }],
        dataPoints: goalData("c1g1", asOf, lin(10, 32)),
      },
      "c1",
    ),
    g(
      {
        ordinal: 2,
        domainNumber: 3,
        tier: 1,
        domain: "Listener Responding",
        category: "communication",
        measure: "percent",
        deficitArea: "communication",
        objective:
          "[Client] will select a named item from an array of three when given the instruction to touch or give the item, across ten targets in 80% of opportunities with accuracy and independence across 5 consecutive sessions with 2 people within the six-month authorization period.",
        rationalePattern: "B",
        rationale:
          "Responding to spoken instructions is the foundation for following directions during daily routines. Without it, [Client] will continue to depend on physical guidance to participate in care routines and early learning activities.",
        linkedMilestones: [{ level: 1, domain: "Listener", from: 3, to: 4 }],
        dataPoints: goalData("c1g2", asOf, lin(15, 35)),
      },
      "c1",
    ),
    g(
      {
        ordinal: 3,
        domainNumber: 8,
        tier: 1,
        domain: "Independent Play and Leisure",
        category: "social_play",
        measure: "percent",
        deficitArea: "social_interaction",
        objective:
          "[Client] will engage with a cause-and-effect toy for two minutes without adult prompting in 80% of opportunities with accuracy and independence across 5 consecutive sessions with 2 people within the six-month authorization period.",
        rationalePattern: "A",
        rationale:
          "This goal builds independent engagement with toys during unstructured time. Baseline probes show independent engagement in {{goal.3.baseline_pct}} of opportunities. Sustained play creates natural opportunities for imitation and social interaction with peers and siblings.",
        linkedMilestones: [{ level: 1, domain: "Play", from: 3, to: 4 }],
        dataPoints: goalData("c1g3", asOf, lin(20, 40)),
      },
      "c1",
    ),
    g(
      {
        ordinal: 4,
        domainNumber: 16,
        tier: 1,
        domain: "Behavior Reduction",
        category: "behavior_reduction",
        measure: "frequency",
        deficitArea: "restricted_repetitive_behavior",
        objective:
          "[Client] will decrease crying and dropping during transitions to an average of fewer than two episodes per session across 5 consecutive sessions with 2 people within the six-month authorization period.",
        rationalePattern: "B",
        rationale:
          "Crying and dropping to the floor during transitions currently interrupt care routines several times a day. If this behavior persists, [Client] will be unable to move safely between activities at home and in the community.",
        dataPoints: goalData("c1g4", asOf, lin(6, 3), { measure: "frequency", noise: 1 }),
      },
      "c1",
    ),
    g(
      {
        ordinal: 5,
        domainNumber: 17,
        tier: 1,
        domain: "Functional Communication (replacement)",
        category: "replacement",
        measure: "percent",
        deficitArea: "communication",
        replacementFor: 4,
        objective:
          "[Client] will use a vocal approximation or picture to request more time when a transition is signaled in 80% of opportunities with accuracy and independence across 5 consecutive sessions with 2 people within the six-month authorization period.",
        rationalePattern: "A",
        rationale:
          "Teaching a request for more time gives [Client] an acceptable way to express the same need that crying currently serves. Baseline data show this request in {{goal.5.baseline_pct}} of transitions. A functional replacement makes the reduction plan sustainable for caregivers.",
        dataPoints: goalData("c1g5", asOf, lin(0, 20)),
      },
      "c1",
    ),
    g(
      {
        ordinal: 6,
        domainNumber: 18,
        tier: 1,
        domain: "Caregiver Goals",
        category: "caregiver",
        measure: "percent",
        deficitArea: "communication",
        objective:
          "[Caregiver] will implement mand training procedures as written in the treatment plan with at least 80% procedural fidelity, as measured by direct observation using the fidelity checklist, across 3 consecutive caregiver training sessions within the six-month authorization period.",
        rationalePattern: "A",
        rationale:
          "This caregiver goal brings mand training into daily routines outside of therapy hours. Fidelity at baseline was {{goal.6.baseline_pct}}. Caregiver implementation is what makes new requesting skills last after services fade.",
        dataPoints: goalData("c1g6", asOf, lin(30, 55), { sparse: true }),
      },
      "c1",
    ),
    g(
      {
        ordinal: 7,
        domainNumber: 18,
        tier: 2,
        domain: "Caregiver Goals",
        category: "caregiver",
        measure: "percent",
        deficitArea: "restricted_repetitive_behavior",
        objective:
          "[Caregiver] will deliver a transition warning and reinforce requests for more time during household transitions with at least 80% procedural fidelity across 3 consecutive caregiver training sessions within the six-month authorization period.",
        rationalePattern: "B",
        rationale:
          "Transitions happen many times a day at home, far more often than in sessions. Without consistent caregiver use of the transition procedure, crying during transitions is likely to persist between sessions.",
        dataPoints: goalData("c1g7", asOf, lin(20, 45), { sparse: true }),
      },
      "c1",
    ),
  ];

  // ----- Client 2: VB-MAPP Level 2, Cigna/Evernorth, first reauth, 40 hrs/week
  const c2Start = addDays(asOf, -160);
  const c2End = addDays(c2Start, 181);
  const c2admin1 = scoresFrom(
    {
      1: { ...all(L1, 5), Echoic: 4, Vocal: 4 },
      2: {
        Mand: 2,
        Tact: 2,
        Listener: 1.5,
        "VP/MTS": 2,
        Play: 1,
        Social: 0.5,
        Imitation: 2,
        Echoic: 0,
        LRFFC: 1,
        IV: 0.5,
        Group: 0.5,
        Linguistics: 1,
      },
    },
    1,
  );
  const c2admin2 = cumulative(
    c2admin1,
    scoresFrom(
      {
        1: all(L1, 5),
        2: {
          Mand: 4,
          Tact: 3.5,
          Listener: 2,
          "VP/MTS": 4,
          Play: 2.5,
          Social: 1.5,
          Imitation: 3,
          Echoic: 1,
          LRFFC: 2.5,
          IV: 2,
          Group: 1.5,
          Linguistics: 2,
        },
        3: { Mand: 0.5, "VP/MTS": 1 },
      },
      2,
    ),
  );
  const c2: SynClient = {
    id: sid("client:2"),
    key: "client2",
    firstName: "Bravo",
    lastName: "Testchild",
    preferredName: "Bravo",
    dob: addMonths(asOf, -76),
    sex: "M",
    serviceAddress: { line1: "2 Imaginary Court", city: "Peachtree City", state: "GA", zip: "30269" },
    guardians: [{ name: "Jordan Testparent", relationship: "Mother", legalCustody: true }],
    hasIep: true,
    events: [],
    diagnoses: [
      {
        id: sid("c2:dx1"),
        dsm5Code: "299.00",
        dsm5Label: "Autism spectrum disorder, requiring support (Level 1)",
        icd10Code: "F84.0",
        isPrimary: true,
        severity: "Level 1",
        evaluationDate: addDays(asOf, -700),
        deficitAreas: ["communication", "social_interaction", "restricted_repetitive_behavior", "adaptive"],
      },
      {
        id: sid("c2:dx2"),
        dsm5Code: "315.32",
        dsm5Label: "Mixed receptive-expressive language disorder",
        icd10Code: "F80.2",
        isPrimary: false,
        severity: "Moderate",
        evaluationDate: addDays(asOf, -700),
        deficitAreas: ["communication"],
      },
    ],
    payors: [
      {
        id: sid("c2:payor"),
        payorKey: "cigna_evernorth",
        priority: "primary",
        memberId: "SYN-CIG-000202",
        planName: "Cigna Open Access Plus (synthetic)",
      },
    ],
    attachments: [
      {
        id: sid("c2:att:dx"),
        kind: "diagnostic_evaluation",
        title: "Diagnostic evaluation",
        documentDate: addDays(asOf, -700),
        caregiverSigned: true,
      },
      {
        id: sid("c2:att:form"),
        kind: "payor_form",
        title: "Evernorth ABA Prior Authorization Form",
        documentDate: addDays(asOf, -5),
        caregiverSigned: true,
      },
      {
        id: sid("c2:att:iep"),
        kind: "iep",
        title: "IEP (current school year)",
        documentDate: addDays(asOf, -90),
        caregiverSigned: true,
      },
    ],
    authorization: {
      id: sid("c2:auth"),
      payorKey: "cigna_evernorth",
      authNumber: "SYN-AUTH-2002",
      kind: "initial",
      startDate: c2Start,
      endDate: c2End,
      recommendedHoursPerWeek: 40,
      units: [
        { cptCode: "97151", approvedUnits: 24, unitBasis: "auth" },
        { cptCode: "97153", approvedUnits: 160, unitBasis: "week" },
        { cptCode: "97155", approvedUnits: 20, unitBasis: "week" },
        { cptCode: "97156", approvedUnits: 4, unitBasis: "week" },
      ],
    },
    sessions: sessionsFor("c2", c2Start, c2End, asOf, (d, dow, week, r) => {
      const s: Omit<SynSession, "id" | "date">[] = [];
      if (dow >= 1 && dow <= 5) {
        // Two short-staffed weeks (8 and 15) fall under the 80% delivery threshold.
        const cancelled = week === 8 || week === 15 ? dow >= 3 : r() < 0.04;
        if (!cancelled)
          s.push({
            cptCode: "97153",
            startMinute: 540,
            units: 32,
            providerRole: "RBT",
            providerId: dow <= 2 ? "RBT-A" : "RBT-B",
            inPerson: true,
          });
        if (!cancelled && dow === 1)
          s.push({
            cptCode: "97155",
            startMinute: 600,
            units: 8,
            providerRole: "BCBA",
            providerId: "BCBA-1",
            inPerson: true,
          });
        if (!cancelled && dow === 4)
          s.push({
            cptCode: "97155",
            startMinute: 600,
            units: 12,
            providerRole: "BCBA",
            providerId: "BCBA-1",
            inPerson: true,
          });
      }
      if (dow === 6 && week !== 8)
        s.push({
          cptCode: "97156",
          startMinute: 600,
          units: 4,
          providerRole: "BCBA",
          providerId: "BCBA-1",
          inPerson: true,
        });
      return s;
    }).concat([
      {
        id: sid("c2:reassess"),
        cptCode: "97151",
        date: addDays(asOf, -20),
        startMinute: 540,
        units: 16,
        providerRole: "BCBA",
        providerId: "BCBA-1",
        inPerson: true,
      },
    ]),
    intake: intakeBase({
      primary_concerns: {
        value: "Speaks in short phrases but rarely starts conversations; hits when tasks are hard.",
      },
      aggression: { value: "moderate", comment: "Hitting adults during demanding tasks" },
      aggression_frequency: { value: { count: 4, per: "day", durationMinutes: 1 } },
      communication_modes: { value: ["Vocal words"] },
      school_placement: { value: "First grade, general education with support" },
      has_iep: { value: true },
      other_therapies: { value: ["Speech therapy"] },
      prior_evaluations: {
        value: [
          {
            type: "Diagnostic evaluation",
            provider: "Pediatric developmental clinic (synthetic)",
            date: addDays(asOf, -700),
          },
        ],
      },
      custody_arrangement: { value: "Sole legal custody" },
    }),
    administrations: [
      {
        id: sid("c2:vb:1"),
        adminNumber: 1,
        testDate: addDays(asOf, -165),
        testerInitials: "AS",
        scores: c2admin1,
      },
      {
        id: sid("c2:vb:2"),
        adminNumber: 2,
        testDate: addDays(asOf, -20),
        testerInitials: "AS",
        scores: c2admin2,
      },
    ],
    goals: [],
  };
  const flatShape = (w: number) => (w < 16 ? 20 + (25 * w) / 15 : 45);
  c2.goals = [
    g(
      {
        ordinal: 1,
        domainNumber: 1,
        tier: 2,
        domain: "Manding (Requesting)",
        category: "communication",
        measure: "percent",
        deficitArea: "communication",
        objective:
          "[Client] will independently mand for a missing item, for assistance, and for attention using a complete sentence frame across ten targets and three communicative functions in 80% of opportunities with accuracy and independence across 5 consecutive sessions with 2 people within the six-month authorization period.",
        rationalePattern: "B",
        rationale:
          "Expanding requests beyond preferred items lets [Client] recruit help and attention through language rather than escalation. Without help-seeking mands, [Client] is likely to keep hitting when tasks become difficult, which limits participation at school and at home.",
        linkedMilestones: [{ level: 2, domain: "Mand", from: 5, to: 7 }],
        dataPoints: goalData("c2g1", asOf, lin(35, 78)),
        phaseChanges: [{ date: addDays(asOf, -26 * 7 + 12 * 7), label: "Phase 2: added assistance mands" }],
      },
      "c2",
    ),
    g(
      {
        ordinal: 2,
        domainNumber: 2,
        tier: 2,
        domain: "Tacting (Labeling)",
        category: "communication",
        measure: "percent",
        deficitArea: "communication",
        objective:
          "[Client] will tact actions, features, and functions of common items across thirty targets in 80% of opportunities with accuracy and independence across 5 consecutive sessions with 2 people within the six-month authorization period.",
        rationalePattern: "A",
        rationale:
          "This goal extends labeling from nouns to actions and features, which conversation depends on. At baseline [Client] tacted these targets in {{goal.2.baseline_pct}} of opportunities. Richer tacts support commenting and peer conversation in the classroom.",
        linkedMilestones: [{ level: 2, domain: "Tact", from: 7, to: 8 }],
        dataPoints: goalData("c2g2", asOf, lin(30, 72)),
      },
      "c2",
    ),
    g(
      {
        ordinal: 3,
        domainNumber: 3,
        tier: 2,
        domain: "Listener Responding",
        category: "communication",
        measure: "percent",
        deficitArea: "communication",
        objective:
          "[Client] will follow two-step instructions involving different items and actions in 80% of opportunities with accuracy and independence across 5 consecutive sessions with 2 people within the six-month authorization period.",
        rationalePattern: "A",
        rationale:
          "This goal targets multi-step listener responding needed to follow classroom directions. Baseline performance was {{goal.3.baseline_pct}} of opportunities. Following multi-step directions allows [Client] to complete routines with less adult support.",
        linkedMilestones: [{ level: 2, domain: "Listener", from: 7, to: 8 }],
        dataPoints: goalData("c2g3", asOf, flatShape, { noise: 3 }),
      },
      "c2",
    ),
    g(
      {
        ordinal: 4,
        domainNumber: 4,
        tier: 2,
        domain: "Intraverbal",
        category: "communication",
        measure: "percent",
        deficitArea: "communication",
        objective:
          "[Client] will answer wh- questions about familiar topics across twenty-five targets in 80% of opportunities with accuracy and independence across 5 consecutive sessions with 2 people within the six-month authorization period.",
        rationalePattern: "B",
        rationale:
          "Answering questions is how [Client] can take part in back-and-forth conversation with adults and peers. If intraverbal responding stays limited, [Client] will remain unable to share information about needs, events, or safety concerns.",
        linkedMilestones: [{ level: 2, domain: "IV", from: 7, to: 8 }],
        dataPoints: goalData("c2g4", asOf, lin(15, 50), { skipWeeks: [9, 10, 17, 18, 19], sparse: true }),
      },
      "c2",
    ),
    g(
      {
        ordinal: 5,
        domainNumber: 9,
        tier: 2,
        domain: "Social Skills — Initiation",
        category: "social_play",
        measure: "percent",
        deficitArea: "social_interaction",
        objective:
          "[Client] will initiate a play interaction with a peer using a verbal invitation during structured play in 80% of opportunities with accuracy and independence across 5 consecutive sessions with 2 people within the six-month authorization period.",
        rationalePattern: "A",
        rationale:
          "This goal targets peer initiations, which open access to cooperative play. Baseline data show initiations in {{goal.5.baseline_pct}} of play opportunities. Initiating with peers generalizes to recess and community settings where adults are less available.",
        linkedMilestones: [{ level: 2, domain: "Social", from: 7, to: 8 }],
        dataPoints: goalData("c2g5", asOf, lin(10, 55)),
      },
      "c2",
    ),
    g(
      {
        ordinal: 6,
        domainNumber: 16,
        tier: 2,
        domain: "Behavior Reduction",
        category: "behavior_reduction",
        measure: "frequency",
        deficitArea: "restricted_repetitive_behavior",
        objective:
          "[Client] will decrease hitting during demand situations to fewer than one episode per session across 5 consecutive sessions with 2 people within the six-month authorization period.",
        rationalePattern: "B",
        rationale:
          "Hitting during demanding tasks poses a risk of injury to staff, peers, and family. If it continues, [Client]'s access to general education instruction and community activities will remain restricted.",
        dataPoints: goalData("c2g6", asOf, lin(5, 1.2), { measure: "frequency", noise: 0.8 }),
      },
      "c2",
    ),
    g(
      {
        ordinal: 7,
        domainNumber: 17,
        tier: 2,
        domain: "Functional Communication (replacement)",
        category: "replacement",
        measure: "percent",
        deficitArea: "communication",
        replacementFor: 6,
        objective:
          "[Client] will request a break or help using a vocal phrase when presented with a difficult task in 80% of opportunities with accuracy and independence across 5 consecutive sessions with 2 people within the six-month authorization period.",
        rationalePattern: "A",
        rationale:
          "This replacement behavior gives [Client] an appropriate way to escape or get help with hard tasks. Baseline data show break requests in {{goal.7.baseline_pct}} of difficult tasks. Reinforcing the request instead of hitting supports durable behavior reduction.",
        dataPoints: goalData("c2g7", asOf, lin(5, 70)),
      },
      "c2",
    ),
    g(
      {
        ordinal: 8,
        domainNumber: 18,
        tier: 1,
        domain: "Caregiver Goals",
        category: "caregiver",
        measure: "percent",
        deficitArea: "communication",
        objective:
          "[Caregiver] will implement prompt-fading procedures for requesting as written in the treatment plan with at least 80% procedural fidelity across 3 consecutive caregiver training sessions within the six-month authorization period.",
        rationalePattern: "A",
        rationale:
          "This caregiver goal carries requesting practice into evenings and weekends. Fidelity began at {{goal.8.baseline_pct}}. Consistent caregiver prompting maintains communication gains outside of therapy hours.",
        dataPoints: goalData("c2g8", asOf, lin(40, 85), { sparse: true }),
      },
      "c2",
    ),
    g(
      {
        ordinal: 9,
        domainNumber: 18,
        tier: 2,
        domain: "Caregiver Goals",
        category: "caregiver",
        measure: "percent",
        deficitArea: "restricted_repetitive_behavior",
        objective:
          "[Caregiver] will implement the antecedent strategies, reactive strategies, and reinforcement schedule in the Behavior Intervention Plan with at least 80% procedural fidelity across 3 consecutive caregiver training sessions within the six-month authorization period.",
        rationalePattern: "B",
        rationale:
          "Homework and chores are the demand situations where hitting is most likely at home. Without consistent use of the behavior plan by caregivers, hitting is likely to continue outside of sessions.",
        dataPoints: goalData("c2g9", asOf, lin(35, 80), { sparse: true }),
      },
      "c2",
    ),
  ];

  // ----- Client 3: TRICARE East, reauth with outcome measures due, bolting safety flag
  const c3Start = addDays(asOf, -170);
  const c3End = addDays(c3Start, 181);
  const telehealthMonth = addDays(c3Start, 75).slice(0, 7);
  const c3: SynClient = {
    id: sid("client:3"),
    key: "client3",
    firstName: "Charlie",
    lastName: "Testchild",
    preferredName: "Charlie",
    dob: addMonths(asOf, -109),
    sex: "M",
    serviceAddress: { line1: "3 Pretend Parkway", city: "Fayetteville", state: "GA", zip: "30214" },
    guardians: [
      { name: "Morgan Testparent", relationship: "Father", legalCustody: true },
      { name: "Taylor Testparent", relationship: "Stepmother", legalCustody: false },
    ],
    hasIep: false,
    events: [],
    diagnoses: [
      {
        id: sid("c3:dx"),
        dsm5Code: "299.00",
        dsm5Label: "Autism spectrum disorder, requiring substantial support (Level 2)",
        icd10Code: "F84.0",
        isPrimary: true,
        severity: "Level 2",
        evaluationDate: addDays(asOf, -900),
        deficitAreas: ["communication", "social_interaction", "restricted_repetitive_behavior", "safety"],
      },
    ],
    payors: [
      {
        id: sid("c3:payor"),
        payorKey: "tricare_east",
        priority: "primary",
        memberId: "SYN-TRI-000303",
        planName: "TRICARE Prime (synthetic)",
      },
      {
        id: sid("c3:payor2"),
        payorKey: "aetna",
        priority: "secondary",
        memberId: "SYN-AET-000304",
        planName: "Aetna Choice POS II (synthetic)",
        secondaryDocsSigned: false,
      },
    ],
    attachments: [
      {
        id: sid("c3:att:dx"),
        kind: "diagnostic_evaluation",
        title: "Diagnostic evaluation",
        documentDate: addDays(asOf, -900),
        caregiverSigned: true,
      },
      {
        id: sid("c3:att:pddbi"),
        kind: "outcome_measure",
        title: "PDDBI parent form",
        documentDate: addDays(asOf, -200),
        caregiverSigned: true,
      },
      {
        id: sid("c3:att:vineland"),
        kind: "outcome_measure",
        title: "Vineland-3",
        documentDate: addDays(asOf, -200),
        caregiverSigned: true,
      },
      {
        id: sid("c3:att:psi"),
        kind: "outcome_measure",
        title: "PSI",
        documentDate: addDays(asOf, -30),
        caregiverSigned: false,
      },
    ],
    authorization: {
      id: sid("c3:auth"),
      payorKey: "tricare_east",
      authNumber: "SYN-AUTH-3003",
      kind: "reauth",
      startDate: c3Start,
      endDate: c3End,
      recommendedHoursPerWeek: 25,
      units: [
        { cptCode: "97151", approvedUnits: 24, unitBasis: "auth" },
        { cptCode: "97153", approvedUnits: 80, unitBasis: "week" },
        { cptCode: "97155", approvedUnits: 8, unitBasis: "week" },
        { cptCode: "97156", approvedUnits: 24, unitBasis: "auth" },
      ],
    },
    sessions: sessionsFor("c3", c3Start, c3End, asOf, (d, dow, week, r) => {
      const s: Omit<SynSession, "id" | "date">[] = [];
      if (dow >= 1 && dow <= 4 && r() > 0.05)
        s.push({
          cptCode: "97153",
          startMinute: 900,
          units: 20,
          providerRole: "RBT",
          providerId: "RBT-C",
          inPerson: true,
        });
      // Supervision on Wednesdays after the direct session; one month delivered only by telehealth.
      if (dow === 3)
        s.push({
          cptCode: "97155",
          startMinute: 1200,
          units: 8,
          providerRole: "BCBA",
          providerId: "BCBA-1",
          inPerson: d.slice(0, 7) !== telehealthMonth,
        });
      // Caregiver training: only three sessions this authorization (TRICARE minimum is six).
      if (dow === 5 && [3, 11, 19].includes(week))
        s.push({
          cptCode: "97156",
          startMinute: 1080,
          units: 4,
          providerRole: "BCBA",
          providerId: "BCBA-1",
          inPerson: true,
        });
      return s;
    }),
    intake: intakeBase({
      primary_concerns: {
        value: "Runs away in parking lots and stores; limited conversation; rigid routines.",
      },
      bolting: {
        value: true,
        comment: "Runs toward the street when outdoors; needs hand-holding in parking lots",
      },
      transportation_risks: { value: ["Unbuckles seat belt", "Runs in parking lots"] },
      communication_modes: { value: ["Vocal words", "Speech-generating device"] },
      school_placement: { value: "Third grade, special education classroom" },
      other_therapies: { value: ["Speech therapy", "Occupational therapy"] },
      prior_evaluations: {
        value: [
          {
            type: "Diagnostic evaluation",
            provider: "Military treatment facility developmental clinic (synthetic)",
            date: addDays(asOf, -900),
          },
          {
            type: "Speech-language evaluation",
            provider: "School district (synthetic)",
            date: addDays(asOf, -400),
          },
        ],
      },
      custody_arrangement: { value: "Sole legal custody" },
      availability: { value: { Mon: [3, 4], Tue: [3, 4], Wed: [3, 4], Thu: [3, 4], Fri: [3, 4] } },
    }),
    administrations: [
      {
        id: sid("c3:vb:1"),
        adminNumber: 1,
        testDate: addDays(asOf, -14),
        testerInitials: "AS",
        scores: scoresFrom(
          {
            1: all(L1, 5),
            2: { ...all(L2, 4), Social: 2.5, IV: 2, Group: 3, Linguistics: 3.5 },
            3: { Mand: 2, Tact: 1.5, Listener: 2, "VP/MTS": 2, Play: 1, Reading: 1, Math: 1 },
          },
          1,
        ),
      },
    ],
    goals: [],
  };
  c3.goals = [
    g(
      {
        ordinal: 1,
        domainNumber: 13,
        tier: 2,
        domain: "Safety and Community Participation",
        category: "other",
        measure: "percent",
        deficitArea: "safety",
        objective:
          "[Client] will stay within arm's reach of an adult while walking through a parking lot or store without physical prompts in 80% of opportunities with accuracy and independence across 5 consecutive sessions with 2 people within the six-month authorization period.",
        rationalePattern: "B",
        rationale:
          "Staying near an adult in parking lots and stores is a critical safety skill. Without it, [Client]'s bolting places him at immediate risk of injury from traffic and limits family access to the community.",
        dataPoints: goalData("c3g1", asOf, lin(20, 60)),
      },
      "c3",
    ),
    g(
      {
        ordinal: 2,
        domainNumber: 4,
        tier: 3,
        domain: "Intraverbal",
        category: "communication",
        measure: "percent",
        deficitArea: "communication",
        objective:
          "[Client] will describe a recent event using at least three details when asked about it in 80% of opportunities with accuracy and independence across 5 consecutive sessions with 2 people within the six-month authorization period.",
        rationalePattern: "A",
        rationale:
          "This goal builds the ability to recount events, which supports conversation and reporting safety concerns. At baseline [Client] gave detailed accounts in {{goal.2.baseline_pct}} of opportunities. Narrative skills transfer to classroom sharing and peer conversation.",
        linkedMilestones: [{ level: 3, domain: "IV", from: 11, to: 12 }],
        dataPoints: goalData("c3g2", asOf, lin(15, 48)),
      },
      "c3",
    ),
    g(
      {
        ordinal: 3,
        domainNumber: 9,
        tier: 3,
        domain: "Social Skills — Initiation",
        category: "social_play",
        measure: "percent",
        deficitArea: "social_interaction",
        objective:
          "[Client] will maintain a conversation with a peer for at least four exchanges on a shared topic in 80% of opportunities with accuracy and independence across 5 consecutive sessions with 2 people within the six-month authorization period.",
        rationalePattern: "A",
        rationale:
          "This goal extends social initiations into sustained conversation. Baseline data show conversations of this length in {{goal.3.baseline_pct}} of opportunities. Sustained conversation is the basis for friendships and group participation at school.",
        linkedMilestones: [{ level: 2, domain: "Social", from: 8, to: 9 }],
        dataPoints: goalData("c3g3", asOf, lin(10, 42)),
      },
      "c3",
    ),
    g(
      {
        ordinal: 4,
        domainNumber: 16,
        tier: 2,
        domain: "Behavior Reduction",
        category: "behavior_reduction",
        measure: "frequency",
        deficitArea: "safety",
        objective:
          "[Client] will decrease elopement attempts in community settings to zero per session across 5 consecutive sessions with 2 people within the six-month authorization period.",
        rationalePattern: "B",
        rationale:
          "Elopement in community settings has resulted in near-misses with traffic. If elopement continues, [Client] cannot safely take part in outings, appointments, or school transitions.",
        dataPoints: goalData("c3g4", asOf, lin(3, 0.8), { measure: "frequency", noise: 0.5 }),
      },
      "c3",
    ),
    g(
      {
        ordinal: 5,
        domainNumber: 17,
        tier: 2,
        domain: "Functional Communication (replacement)",
        category: "replacement",
        measure: "percent",
        deficitArea: "communication",
        replacementFor: 4,
        objective:
          "[Client] will ask to go to a preferred place using his device or a vocal phrase instead of running in 80% of opportunities with accuracy and independence across 5 consecutive sessions with 2 people within the six-month authorization period.",
        rationalePattern: "A",
        rationale:
          "This replacement behavior lets [Client] request access to a preferred destination rather than running toward it. At baseline [Client] made this request in {{goal.5.baseline_pct}} of opportunities. Honoring the request when safe reduces the motivation to elope.",
        dataPoints: goalData("c3g5", asOf, lin(5, 55)),
      },
      "c3",
    ),
    g(
      {
        ordinal: 6,
        domainNumber: 18,
        tier: 2,
        domain: "Caregiver Goals",
        category: "caregiver",
        measure: "percent",
        deficitArea: "safety",
        objective:
          "[Caregiver] will implement the community safety protocol, including hand-holding transitions and reinforcement for staying close, with at least 80% procedural fidelity across 3 consecutive caregiver training sessions within the six-month authorization period.",
        rationalePattern: "B",
        rationale:
          "Most community outings happen with caregivers rather than staff. Without caregiver fidelity on the safety protocol, elopement risk remains high during family outings.",
        dataPoints: goalData("c3g6", asOf, lin(30, 60), { sparse: true }),
      },
      "c3",
    ),
    g(
      {
        ordinal: 7,
        domainNumber: 18,
        tier: 3,
        domain: "Caregiver Goals",
        category: "caregiver",
        measure: "percent",
        deficitArea: "communication",
        objective:
          "[Caregiver] will independently conduct a generalization probe for the conversation goal using the provided data sheet and identify whether the mastery criterion was met across 3 consecutive caregiver training sessions within the six-month authorization period.",
        rationalePattern: "A",
        rationale:
          "This goal prepares caregivers to monitor skill maintenance as services fade. Baseline probe accuracy was {{goal.7.baseline_pct}}. Caregiver-run probes give the team data on generalization at home.",
        dataPoints: goalData("c3g7", asOf, lin(20, 50), { sparse: true }),
      },
      "c3",
    ),
  ];

  // ----- Other org: one client, used only to prove isolation
  const other: SynClient = {
    ...c1,
    id: sid("client:other1"),
    key: "other1",
    firstName: "Delta",
    lastName: "Otherorg",
    preferredName: "Delta",
    payors: [
      {
        id: sid("o1:payor"),
        payorKey: "aetna",
        priority: "primary",
        memberId: "SYN-AET-009901",
        planName: "Aetna (synthetic)",
      },
    ],
    diagnoses: [{ ...c1.diagnoses[0]!, id: sid("o1:dx") }],
    attachments: [],
    authorization: {
      ...c1.authorization,
      id: sid("o1:auth"),
      payorKey: "aetna",
      authNumber: "SYN-AUTH-9901",
    },
    sessions: [],
    administrations: [],
    goals: [],
  };

  return {
    asOf,
    orgs: [
      {
        id: orgId,
        name: "Sample Practice",
        settings: {
          city: "Peachtree City",
          state: "GA",
          npi: "SYN-NPI-0000000000",
          taxId: "SYN-TIN-00-0000000",
          offices: [{ state: "GA", address: "100 Example Way, Peachtree City, GA 30269" }],
          reauthLeadDays: 30,
          reassessmentLeadDays: 45,
        },
        users,
        clients: [c1, c2, c3],
      },
      {
        id: otherOrgId,
        name: "Other Sample Practice",
        settings: { city: "Example City", state: "GA", offices: [] },
        users: [
          {
            id: sid("user:other-bcba"),
            email: "bcba@other-practice.test",
            name: "Jamie Other, BCBA",
            password: DEMO_PASSWORD,
            totpSecret: "ONSWG4TFOQYTEMZUGU3DOOBZONSWG4TF",
            role: "BCBA",
          },
        ],
        clients: [other],
      },
    ],
  };
}
