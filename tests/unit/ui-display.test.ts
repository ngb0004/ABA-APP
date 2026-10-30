import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { label, labeled } from "@/components/labels";
import {
  humanizeKey,
  paramEntries,
  plural,
  revokeNoteFromPrompt,
  summarizeChecks,
} from "@/components/payor-display";
import { HttpError } from "@/lib/log";
import { describeNetworkError } from "@/lib/rules-watch/fetch";
import { isNotFoundError, loadOr404 } from "@/lib/server/not-found";

describe("unknown records become a 404, not a server error", () => {
  const prismaMiss = new Prisma.PrismaClientKnownRequestError("No record was found for a query.", {
    code: "P2025",
    clientVersion: "test",
  });

  it("recognizes service 404s and Prisma not-found errors", () => {
    expect(isNotFoundError(new HttpError(404, "Not found"))).toBe(true);
    expect(isNotFoundError(prismaMiss)).toBe(true);
    expect(isNotFoundError(Object.assign(new Error("No Client found"), { name: "NotFoundError" }))).toBe(
      true,
    );
  });

  it("leaves every other error alone", () => {
    expect(isNotFoundError(new HttpError(403, "Forbidden"))).toBe(false);
    expect(isNotFoundError(new Error("connection refused"))).toBe(false);
    expect(isNotFoundError("No Client found")).toBe(false);
    expect(isNotFoundError(null)).toBe(false);
  });

  it("calls the not-found handler only for a missing record", async () => {
    const onNotFound = (): never => {
      throw new Error("NOT_FOUND");
    };
    await expect(loadOr404(async () => 7, onNotFound)).resolves.toBe(7);
    await expect(
      loadOr404(async () => {
        throw prismaMiss;
      }, onNotFound),
    ).rejects.toThrow("NOT_FOUND");
    await expect(
      loadOr404(async () => {
        throw new HttpError(404, "Plan not found");
      }, onNotFound),
    ).rejects.toThrow("NOT_FOUND");
    const boom = new Error("database down");
    await expect(
      loadOr404(async () => {
        throw boom;
      }, onNotFound),
    ).rejects.toBe(boom);
  });
});

describe("revoke prompt", () => {
  it("Cancel (null) never revokes", () => {
    expect(revokeNoteFromPrompt(null)).toEqual({ revoke: false });
  });
  it("OK revokes, with or without a note", () => {
    expect(revokeNoteFromPrompt("")).toEqual({ revoke: true, note: null });
    expect(revokeNoteFromPrompt("  ")).toEqual({ revoke: true, note: null });
    expect(revokeNoteFromPrompt(" new edition ")).toEqual({ revoke: true, note: "new edition" });
  });
});

describe("payor rule display", () => {
  it("renders parameters as readable label/value pairs", () => {
    expect(
      paramEntries({
        doc: "Updated data from previous authorization",
        when: "reauth",
        max_age_months_before_effective: 2,
        optional: true,
        must_include: ["parent_concerns", "crisis_plan"],
        when_if: "if_applicable",
      }),
    ).toEqual([
      ["Doc", "Updated data from previous authorization"],
      ["When", "reauth"],
      ["Max age months before effective", "2"],
      ["Optional", "yes"],
      ["Must include", "parent concerns, crisis plan"],
      ["When if", "if applicable"],
    ]);
    expect(paramEntries({ caps: { "97153": 8 } })).toEqual([["Caps", "97153: 8"]]);
    expect(paramEntries(null)).toEqual([]);
    expect(humanizeKey("severity_if_missed")).toBe("Severity if missed");
  });

  it("pluralizes counts", () => {
    expect(plural(1, "rule")).toBe("1 rule");
    expect(plural(33, "rule")).toBe("33 rules");
  });

  it("summarizes a source check", () => {
    const ok = { name: "A", health: "ok", newVersion: false, error: null };
    expect(
      summarizeChecks([ok, ok, { name: "TRICARE manual", health: "broken", newVersion: false, error: "x" }]),
    ).toBe("Checked 3 sources: no new versions; 1 could not be reached (TRICARE manual).");
    expect(summarizeChecks([{ ...ok, name: "GA manual", health: "changed", newVersion: true }])).toBe(
      "Checked 1 source: 1 new version (GA manual).",
    );
    expect(summarizeChecks([])).toBe("No sources have a public link to check.");
  });
});

describe("network errors in plain language", () => {
  it("explains certificate, reachability and timeout failures and keeps the code", () => {
    expect(describeNetworkError("UNABLE_TO_VERIFY_LEAF_SIGNATURE")).toBe(
      "Could not connect securely: the site's security certificate could not be checked [UNABLE_TO_VERIFY_LEAF_SIGNATURE]",
    );
    expect(describeNetworkError("ENOTFOUND")).toBe("Could not reach the site [ENOTFOUND]");
    expect(describeNetworkError("ETIMEDOUT")).toBe(
      "Timed out: the site took too long to respond [ETIMEDOUT]",
    );
    expect(describeNetworkError("TIMEOUT")).toBe("Timed out: the site took too long to respond");
    expect(describeNetworkError("EWHATEVER")).toBe("Could not connect to the site [EWHATEVER]");
    expect(describeNetworkError(undefined)).toBe("Could not connect to the site");
  });
});

describe("labels", () => {
  it("shows stored codes in plain English without changing the stored value", () => {
    expect(label("diagnostic_evaluation")).toBe("Diagnostic evaluation");
    expect(label("iep")).toBe("IEP");
    expect(label("reauth")).toBe("Reauthorization");
    expect(label("AUTH_COORDINATOR")).toBe("Authorization coordinator");
    expect(label("something_new")).toBe("Something new");
    expect(labeled(["primary", "secondary"])).toEqual([
      { value: "primary", label: "Primary" },
      { value: "secondary", label: "Secondary" },
    ]);
  });
});
