import { describe, expect, it } from "vitest";
import { assertMinimumNecessary, AiPrivacyError, payloadManifest } from "@/lib/ai";
import { pseudonymize } from "@/lib/intake/derive";
import { findDate, redactDate } from "@/lib/privacy/dates";
import { containsName } from "@/lib/privacy/names";
import { markUnverifiedFigures, redactLetterForAi, UNVERIFIED_FIGURE_PREFIX } from "@/lib/services/letters";

const names = { client: ["José", "Zoë", "Ángel"], others: ["Chloé", "Siobhan O'Brien", "Anne-Marie"] };

describe("pseudonymize: names outside ASCII", () => {
  it("replaces names that start or end with an accented letter", () => {
    expect(pseudonymize("José likes trains. Zoë and Ángel play; Chloé reports tantrums.", names)).toBe(
      "[Client] likes trains. [Client] and [Client] play; [Caregiver] reports tantrums.",
    );
  });

  it("matches a name written without its accents, or in decomposed form", () => {
    expect(pseudonymize("Jose and Zoe, also José", names)).toBe("[Client] and [Client], also [Client]");
  });

  it("matches apostrophe and hyphen names, either apostrophe", () => {
    expect(pseudonymize("Siobhan O’Brien and Anne-Marie came.", names)).toBe(
      "[Caregiver] and [Caregiver] came.",
    );
  });

  it("does not match inside a longer word", () => {
    expect(pseudonymize("Joséphine and Zoëy", names)).toBe("Joséphine and Zoëy");
  });
});

describe("privacy guard", () => {
  const ids = { names: [...names.client, ...names.others], dob: "2019-03-04", memberIds: ["SYN-1"] };

  it.each(["José likes trains", "zoë", "ÁNGEL", "Chloe said", "Siobhan O’Brien called"])(
    "refuses a prompt with %j",
    (p) => {
      expect(() => assertMinimumNecessary(p, ids)).toThrow(AiPrivacyError);
    },
  );

  it.each(["DOB March 4, 2019", "born 03/04/19", "4 March 2019", "2019/3/4", "Mar. 4th, 2019"])(
    "refuses the date of birth written as %j",
    (p) => {
      expect(() => assertMinimumNecessary(p, ids)).toThrow(/date of birth/);
    },
  );

  it("names the failed check, never the value", () => {
    try {
      assertMinimumNecessary("José", ids);
    } catch (e) {
      expect((e as AiPrivacyError).check).toBe("name");
      expect((e as Error).message).not.toContain("José");
    }
  });

  it("passes other dates", () => {
    expect(() => assertMinimumNecessary("Auth from 03/05/2019 to April 4, 2019", ids)).not.toThrow();
  });
});

describe("date matching", () => {
  it("finds every written form of one date", () => {
    expect(findDate("a 3/4/2019 b March 4, 2019 c 2019-03-04 d 03/05/2019", "2019-03-04").sort()).toEqual(
      ["2019-03-04", "3/4/2019", "March 4, 2019"].sort(),
    );
  });
  it("redacts them", () => {
    expect(redactDate("born 03/04/19.", "2019-03-04", "[dob]")).toBe("born [dob].");
  });
});

describe("letter redaction for the AI", () => {
  it("removes the DOB in any form, the street line, ZIP, phone numbers, member IDs and names", () => {
    const text =
      "Member: José Rivera, ID SYN-77, DOB March 4, 2019. 12 Elm Street, Atlanta GA 30301. Call (404) 555-0100. Approved 01/01/2026 to 06/30/2026.";
    const out = redactLetterForAi(text, {
      names: { client: ["José", "Rivera"], others: [] },
      memberIds: ["SYN-77"],
      dob: "2019-03-04",
      serviceAddress: { line1: "12 Elm Street", city: "Atlanta", state: "GA", zip: "30301" },
    });
    expect(out).toBe(
      "Member: [Client] [Client], ID [member-id], DOB [dob]. [address], Atlanta GA [zip]. Call [phone]. Approved 01/01/2026 to 06/30/2026.",
    );
  });
});

describe("letter requirements", () => {
  const letter = "Submit updated goals within 14 days of this notice.";
  it("keeps a requirement copied word for word", () => {
    expect(markUnverifiedFigures("Submit updated goals within 14 days", letter)).toBe(
      "Submit updated goals within 14 days",
    );
  });
  it("marks a paraphrase whose figure is not in the letter", () => {
    expect(markUnverifiedFigures("Submit goals within 10 days", letter)).toBe(
      UNVERIFIED_FIGURE_PREFIX + "Submit goals within 10 days",
    );
  });
  it("leaves a requirement with no figure alone", () => {
    expect(markUnverifiedFigures("Send a parent training summary", letter)).toBe(
      "Send a parent training summary",
    );
  });
});

describe("AI-call manifest", () => {
  it("lists keys and intake field ids, never values", () => {
    const m = payloadManifest({ task: "x", intake: { fields: { school_placement: "secret text" } } });
    expect(m).toEqual({ keys: ["intake", "task"], fieldIds: ["school_placement"], textChars: 12 });
    expect(JSON.stringify(m)).not.toContain("secret");
  });
});

it("containsName ignores one-letter names", () => {
  expect(containsName("a b c", "a")).toBe(false);
});
