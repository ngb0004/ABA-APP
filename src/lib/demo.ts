/**
 * Hosted demo mode (DEMO_MODE=true). The demo runs on ordinary hosting without
 * HIPAA safeguards, so it must never receive real documents: uploads are limited
 * to the bundled synthetic sample files, matched by content hash.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { sha256 } from "./audit";
import { HttpError } from "./log";

export const isDemo = () => process.env.DEMO_MODE === "true";

export const DEMO_SAMPLES = {
  vbmapp: ["sample_B_level1.xlsm", "sample_A_level2.xlsm", "blank_template.xlsm"],
  letters: [
    "client2_cigna_approval.txt",
    "client2_cigna_approval.pdf",
    "client3_tricare_rfi.txt",
    "denial.txt",
    "reduction.txt",
    "p2p_offer.txt",
  ],
} as const;
export type SampleKind = keyof typeof DEMO_SAMPLES;

export function sampleFile(kind: SampleKind, name: string): Buffer {
  if (!(DEMO_SAMPLES[kind] as readonly string[]).includes(name))
    throw new HttpError(404, "Unknown sample file");
  return readFileSync(path.join(process.cwd(), "fixtures", kind, name));
}

let hashes: Set<string> | null = null;
function sampleHashes() {
  hashes ??= new Set(
    (Object.keys(DEMO_SAMPLES) as SampleKind[]).flatMap((k) =>
      DEMO_SAMPLES[k].map((n) => sha256(sampleFile(k, n))),
    ),
  );
  return hashes;
}

/** In demo mode, reject anything that is not one of the bundled synthetic samples. */
export function assertDemoUploadAllowed(data: Buffer) {
  if (isDemo() && !sampleHashes().has(sha256(data)))
    throw new HttpError(
      403,
      "This is the demo site: only the bundled sample files can be uploaded. Never upload real client documents here.",
    );
}
