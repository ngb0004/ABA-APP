/** Prints the current TOTP code for a seeded synthetic demo user. Local development only. */
import { authenticator } from "otplib";
import { buildDataset } from "../seed/synthetic/dataset";

const email = process.argv[2] ?? "bcba@sample-practice.test";
const user = buildDataset("2000-01-01")
  .orgs.flatMap((o) => o.users)
  .find((u) => u.email === email);
if (!user) {
  console.error(`No synthetic demo user ${email}`);
  process.exit(1);
}
console.log(authenticator.generate(user.totpSecret));
