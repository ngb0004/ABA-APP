import { describe, expect, it } from "vitest";
import { renderTokens, SourcedContext, validateAiText, validateBcbaText } from "@/lib/firewall";

const ctx = new SourcedContext([
  {
    key: "client.name",
    label: "Client preferred name",
    value: "Bravo",
    display: "Bravo",
    source: { kind: "client", id: "c1", field: "preferredName", description: "Client record" },
  },
  {
    key: "score.total.admin2",
    label: "VB-MAPP total, administration 2",
    value: 92.5,
    display: "92.5",
    source: {
      kind: "vbmapp_administration",
      id: "a2",
      field: "totals.total",
      description: "VB-MAPP administration 2 (recomputed)",
      href: "/clients/c1/vbmapp#admin-2",
    },
  },
  {
    key: "auth.97153.units_per_week",
    label: "Approved 97153 units per week",
    value: 160,
    display: "160",
    source: {
      kind: "authorization_unit",
      id: "u1",
      field: "approvedUnits",
      description: "Authorization SYN-AUTH-2",
    },
  },
]);

describe("numeric firewall: AI output", () => {
  it("rejects a raw digit", () => {
    const r = validateAiText("Bravo scored 92 points on the VB-MAPP.", ctx);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.kind === "digit")).toBe(true);
  });

  it("rejects an unknown key", () => {
    const r = validateAiText("Total score was {{score.total.admin9}}.", ctx);
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual([
      expect.objectContaining({ kind: "unknown_key", detail: "score.total.admin9" }),
    ]);
  });

  it("rejects spelled-out numbers and percent words", () => {
    expect(validateAiText("[Client] mastered twelve targets.", ctx).ok).toBe(false);
    expect(validateAiText("[Client] improved by fifty percent.", ctx).ok).toBe(false);
  });

  it("rejects a goal referred to by number, in digits or words", () => {
    const kinds = (t: string) => validateAiText(t, ctx).errors.map((e) => e.kind);
    expect(kinds("Progress on Goal 2 was steady.")).toContain("digit");
    expect(kinds("Progress on Goal Two was steady.")).toContain("number_word");
    expect(kinds("Progress on goal three was steady.")).toContain("number_word");
    expect(kinds("Progress on the second goal was steady.")).toContain("number_word");
    // "one" is usually a pronoun, but "Goal One" names a goal by number.
    expect(kinds("Progress on Goal One was steady.")).toContain("number_word");
    expect(kinds("Progress on goal #A was steady.")).toContain("number_word");
    expect(kinds("Progress on goal number A was steady.")).toContain("number_word");
    // Goals named by their skill pass.
    expect(
      validateAiText("Progress on the manding goal was steady; one goal was discontinued.", ctx).ok,
    ).toBe(true);
    expect(validateAiText("Each goal's data are graphed.", ctx).ok).toBe(true);
  });

  it("rejects malformed tokens and non-ASCII digits", () => {
    expect(validateAiText("Score {{score.total.admin2} rose.", ctx).ok).toBe(false);
    expect(validateAiText("Score ٩ rose.", ctx).ok).toBe(false);
  });

  it("accepts a valid token and normalizes [Client]", () => {
    const r = validateAiText(
      "[Client] reached a total of {{score.total.admin2}} with {{ auth.97153.units_per_week }} units weekly.",
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(r.normalized).toBe(
      "{{client.name}} reached a total of {{score.total.admin2}} with {{auth.97153.units_per_week}} units weekly.",
    );
  });
});

describe("numeric firewall: rendering", () => {
  it("links a value by its stable anchor and hover text when it has them", () => {
    const value = (key: string) => ({
      key,
      label: "Manding goal mastery accuracy",
      value: 80,
      display: "80%",
      anchor: "goal-g1.mastery_pct",
      title: "Manding goal: “independently mand” mastery accuracy. Source: goal record",
      source: { kind: "goal", id: "g1", description: "goal record", href: "/clients/c1/goals#goal-g1" },
    });
    // The same goal record under two token numbers (before and after an earlier goal is removed).
    const before = renderTokens(
      "At {{goal.3.mastery_pct}}.",
      new SourcedContext([value("goal.3.mastery_pct")]),
      "html",
    );
    const after = renderTokens(
      "At {{goal.2.mastery_pct}}.",
      new SourcedContext([value("goal.2.mastery_pct")]),
      "html",
    );
    expect(after).toBe(before);
    expect(before).toContain('data-key="goal-g1.mastery_pct"');
    expect(before).not.toMatch(/goal\.\d/);
  });

  it("renders a valid token with its source link", () => {
    const html = renderTokens("Total {{score.total.admin2}}.", ctx, "html");
    expect(html).toContain("92.5");
    expect(html).toContain('href="/clients/c1/vbmapp#admin-2"');
    expect(html).toContain('data-key="score.total.admin2"');
    expect(html).toContain("VB-MAPP administration 2 (recomputed)");
  });

  it("renders plain text for PDF footnotes", () => {
    expect(renderTokens("{{client.name}}: {{score.total.admin2}}", ctx, "text")).toBe("Bravo: 92.5");
  });

  it("resolves [Client] placeholders from the client record", () => {
    expect(renderTokens("[Client] will mand.", ctx, "text")).toBe("Bravo will mand.");
  });

  it("escapes HTML in surrounding text", () => {
    expect(renderTokens("<b>x</b>", ctx, "html")).toContain("&lt;b&gt;");
  });

  it("throws on render of an unknown key rather than printing it", () => {
    expect(() => renderTokens("{{nope}}", ctx, "html")).toThrow(/unknown/i);
  });
});

describe("BCBA-authored text", () => {
  it("allows digits but reports them as unsourced numbers", () => {
    const r = validateBcbaText("Parent reports 3 meltdowns daily.", ctx);
    expect(r.ok).toBe(true);
    expect(r.unsourcedNumbers).toEqual(["3"]);
  });
  it("still rejects unknown keys", () => {
    expect(validateBcbaText("{{bogus.key}}", ctx).ok).toBe(false);
  });
});
