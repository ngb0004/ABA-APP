import type { LlmProvider, LlmRequest, LlmResponse } from "./provider";

/**
 * Deterministic provider for tests and offline development. With a script, it
 * returns the scripted outputs in order (to exercise firewall rejection and
 * retry). Otherwise it writes a short token-only draft from the keys it was given.
 */
export class MockProvider implements LlmProvider {
  readonly name = "mock";
  readonly model = "mock-model";
  calls: LlmRequest[] = [];
  constructor(private script: string[] = []) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.calls.push(req);
    const scripted = this.script.shift();
    if (scripted !== undefined) return { text: scripted, model: this.model };
    return { text: this.generate(req.user), model: this.model };
  }

  private generate(user: string): string {
    let input: {
      task?: string;
      sectionTitle?: string;
      availableValues?: { key: string; label: string }[];
      letterText?: string;
    } = {};
    try {
      input = JSON.parse(user);
    } catch {
      /* free text */
    }
    if (input.task === "classify_letter") return JSON.stringify(mockClassify(input.letterText ?? ""));
    const keys = (input.availableValues ?? []).map((v) => v.key);
    // Latest matching key (e.g., the most recent VB-MAPP administration).
    const pick = (prefix: string) => keys.filter((k) => k.startsWith(prefix)).at(-1);
    const sentences = [
      `This section summarizes ${input.sectionTitle?.toLowerCase().replace(/\d/g, "") ?? "the plan"} for {{client.name}}.`,
    ];
    const total = pick("score.total.");
    if (total) sentences.push(`The most recent recomputed assessment total is {{${total}}}.`);
    const hours = pick("auth.97153.hours_per_week");
    if (hours) sentences.push(`Direct treatment is authorized at {{${hours}}} hours per week.`);
    const goal = keys.find((k) => /^goal\.\d+\.current_pct$/.test(k));
    if (goal)
      sentences.push(
        `Current performance on the lead goal is {{${goal}}} percent of opportunities.`.replace(
          " percent",
          "",
        ),
      );
    sentences.push("The BCBA should review this draft against the session data before approval.");
    return sentences.join(" ");
  }
}

/** Rule-based letter classifier used by the mock provider. Quotes are copied verbatim from the letter. */
function mockClassify(text: string) {
  const lower = text.toLowerCase();
  const classification = /peer[- ]to[- ]peer/.test(lower)
    ? "p2p_offer"
    : /\bdenied\b|\bdenial\b/.test(lower)
      ? "denial"
      : /\breduc/.test(lower)
        ? "reduction"
        : /additional information|request for information/.test(lower)
          ? "request_for_info"
          : "approval";
  const quotes: { field: string; quote: string }[] = [];
  const find = (field: string, re: RegExp) => {
    const m = text.match(re);
    if (m) quotes.push({ field, quote: m[0] });
  };
  find("start_date", /(?:effective|start(?:ing)?|from)\s+(?:date\s+)?(?:of\s+)?\d{1,2}\/\d{1,2}\/\d{4}/i);
  find("end_date", /(?:through|until|to|end(?:ing)?)\s+(?:date\s+)?\d{1,2}\/\d{1,2}\/\d{4}/i);
  for (const code of ["97151", "97153", "97155", "97156"]) {
    const m = text.match(new RegExp(`${code}[^\\n.]*?\\d+\\s+units[^\\n.]*`, "i"));
    if (m) quotes.push({ field: `units.${code}`, quote: m[0] });
  }
  find("auth_number", /authorization (?:number|#)\s*:?\s*[A-Z0-9-]+/i);
  find("deadline", /(?:no later than|by|within)\s+(?:\d{1,2}\/\d{1,2}\/\d{4}|\d+\s+(?:business\s+)?days)/i);
  // Requirements are the bullets after a "next request" / "please provide" lead-in.
  const lead = text.search(/next request|please (?:include|provide)/i);
  const requirements =
    lead < 0 ? [] : [...text.slice(lead).matchAll(/^\s*[-•*]\s+(.+)$/gm)].map((m) => m[1]!.trim());
  return { classification, quotes, requirements };
}
