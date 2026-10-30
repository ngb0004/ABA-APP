import type { ZodError } from "zod";

type Issue = ZodError["issues"][number];

/** Field names whose plain camelCase-to-words form reads badly. */
const LABELS: Record<string, string> = {
  ageYears: "Age",
  authNumber: "Authorization number",
  authorizationId: "Authorization",
  cptCode: "CPT code",
  dob: "Date of birth",
  dsm5Code: "DSM-5 code",
  dsm5Label: "DSM-5 diagnosis",
  icd10Code: "ICD-10 code",
  line1: "Street address",
  memberId: "Member ID",
  npi: "NPI",
  payorId: "Payor",
  providerId: "Staff code",
  startMinute: "Start time",
  taxId: "Tax ID",
  units: "Units",
  zip: "ZIP",
};

/** "approvedUnits" -> "Approved units". */
export function fieldLabel(key: string): string {
  if (LABELS[key]) return LABELS[key];
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Zod's built-in messages ("Too small: expected ..."); schema-supplied messages are kept as written. */
const DEFAULT_MESSAGE =
  /^(Invalid input|Invalid option|Invalid string|Invalid (email|UUID|URL)|Too small|Too big)/i;

function rewrite(i: Issue): string {
  const x = i as Issue & {
    origin?: string;
    minimum?: number | bigint;
    maximum?: number | bigint;
    inclusive?: boolean;
    expected?: string;
    format?: string;
  };
  switch (x.code) {
    case "invalid_type":
      if (/received (undefined|null)/.test(x.message)) return "is required";
      if (x.expected === "int") return "must be a whole number";
      if (x.expected === "number") return "must be a number";
      if (x.expected === "boolean") return "must be yes or no";
      if (x.expected === "array") return "must be a list";
      return "is not valid";
    case "too_small": {
      const n = Number(x.minimum);
      if (x.origin === "string") return n <= 1 ? "is required" : `must be at least ${n} characters`;
      if (x.origin === "array" || x.origin === "set")
        return n <= 1 ? "needs at least one entry" : `needs at least ${n} entries`;
      return x.inclusive === false ? `must be more than ${n}` : `must be at least ${n}`;
    }
    case "too_big": {
      const n = Number(x.maximum);
      if (x.origin === "string") return `must be at most ${n} characters`;
      if (x.origin === "array" || x.origin === "set") return `can have at most ${n} entries`;
      return x.inclusive === false ? `must be less than ${n}` : `must be ${n} or less`;
    }
    case "invalid_format":
      if (x.format === "email") return "must be a valid email address";
      return "is not in the right format";
    case "invalid_value":
      return "must be one of the listed options";
    default:
      return "is not valid";
  }
}

/**
 * One plain sentence per problem, with human field names and rows numbered from 1:
 * ["units", 0, "approvedUnits"] / too_small -> "Approved units (units row 1) must be at least 1."
 * Only field names and limits appear, never the submitted values (no PHI in responses).
 */
export function formatIssue(i: Issue): string {
  const keys = i.path.filter((p): p is string => typeof p === "string");
  const last = keys[keys.length - 1];
  // Where the field sits: every list it is inside, e.g. "units row 2".
  const where: string[] = [];
  i.path.forEach((p, n) => {
    if (typeof p !== "number") return;
    const parent = i.path[n - 1];
    where.push(`${typeof parent === "string" ? fieldLabel(parent).toLowerCase() + " " : ""}row ${p + 1}`);
  });
  const lastIsRow = typeof i.path[i.path.length - 1] === "number";
  const row = lastIsRow ? where.pop()! : "";
  const label = lastIsRow ? row.charAt(0).toUpperCase() + row.slice(1) : last ? fieldLabel(last) : "";
  const at = where.length ? ` (${where.join(", ")})` : "";
  const end = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);
  if (!DEFAULT_MESSAGE.test(i.message)) {
    // The schema's own message: prefix the field unless the message already names it.
    if (!label || i.message.toLowerCase().startsWith(label.toLowerCase())) return end(i.message + at);
    return end(`${label}${at}: ${i.message}`);
  }
  return end(`${label || "The request"}${at} ${rewrite(i)}`);
}

export const formatIssues = (issues: readonly Issue[]) => issues.map(formatIssue);
