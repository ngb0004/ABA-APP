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
