import { afterAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { log, scrub, setLogSink } from "@/lib/log";
import { errorResponse } from "@/lib/server/api";
import { clientDetail, listClients } from "@/lib/services/clients";
import { AS_OF, dataset } from "../helpers/synthetic-eval";
import { clientId, ctxAs } from "../helpers/ctx";

const lines: string[] = [];
setLogSink((l) => lines.push(l));
afterAll(() => setLogSink((l) => process.stderr.write(l + "\n")));

const NAMES = dataset.orgs.flatMap((o) =>
  o.clients.flatMap((c) => [c.firstName, c.lastName, ...c.guardians.map((g) => g.name)]),
);
const PHI_SHAPED = /SYN-[A-Z]{3}-\d+/;

describe("no PHI-shaped data in logs", () => {
  it("scrubs member IDs, dates, emails, and registered client names", async () => {
    await listClients(ctxAs("BCBA")); // registers client names for scrubbing
    log.error("Lookup failed for Bravo Testchild SYN-CIG-000202 born 2020-06-01 contact jordan@example.test");
    log.warn("Upload by Charlie Testchild on 07/09/2026");
    const out = lines.join("\n");
    expect(out).not.toMatch(PHI_SHAPED);
    for (const n of ["Bravo", "Testchild", "Charlie"]) expect(out).not.toContain(n);
    expect(out).toContain("[member-id]");
    expect(out).toContain("[date]");
    expect(scrub("SYN-TRI-000303")).toBe("[member-id]");
  });

  it("never echoes internal error messages to clients or logs", async () => {
    const res = errorResponse(new Error("violates constraint for Alpha Testchild SYN-AMG-000101"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toMatch(/Alpha|SYN-/);
    expect(lines.join("\n")).not.toMatch(/Alpha|SYN-AMG/);
  });

  it("a full client read writes nothing PHI-shaped to the log", async () => {
    lines.length = 0;
    await clientDetail(ctxAs("BCBA"), clientId("client3"), AS_OF);
    const out = lines.join("\n");
    expect(out).not.toMatch(PHI_SHAPED);
    for (const n of NAMES) expect(out).not.toContain(n);
  });
});

describe("repository hygiene", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      if (
        [
          "node_modules",
          ".next",
          ".next-e2e",
          ".git",
          "test-results",
          "playwright-report",
          "exports",
          "fixtures",
        ].includes(f)
      )
        continue;
      const p = path.join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx|js|mjs|json|ya?ml|sh|sql|md)$/.test(f) && f !== "pnpm-lock.yaml") files.push(p);
    }
  };
  walk(process.cwd());

  it("contains no secrets", () => {
    const secret =
      /(sk-ant-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN (RSA |EC )?PRIVATE KEY-----|ghp_[A-Za-z0-9]{30,})/;
    for (const f of files) expect(readFileSync(f, "utf8"), f).not.toMatch(secret);
  });

  it("writes to the console only from scripts, seeds, tests, and the scrubbing logger", () => {
    const offenders = files.filter(
      (f) =>
        f.includes(`${path.sep}src${path.sep}`) &&
        !f.endsWith(path.join("lib", "log.ts")) &&
        /console\.(log|error|warn|info|debug)\(/.test(readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
