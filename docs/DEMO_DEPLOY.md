# Demo site on Railway

A hosted demo with the **fictional clients only**, so you can try the app from a phone or laptop. Railway builds it straight from the GitHub repo.

> **Never put real client information on the demo site.** It runs on ordinary hosting without the HIPAA safeguards in `docs/HIPAA_DEPLOYMENT.md`. In demo mode, uploads accept only the bundled sample files, but typed text is not filtered, so don't type real details either.

Cost: Railway's Hobby plan is $5/month including some usage; with the database and the PDF tooling, expect roughly $5–10/month. Set a spending limit under your Railway workspace's usage settings.

## One-time setup (about 15 minutes)

1. **Create an account.** Go to [railway.com](https://railway.com) and sign in with GitHub (the account that owns `ngb0004/aba-app`). Choose the Hobby plan.
2. **Create the project from the repo.**
   - Click **New Project → Deploy from GitHub repo**.
   - If asked, let Railway's GitHub app access `ngb0004/aba-app`.
   - Pick `aba-app`. Railway finds the `Dockerfile` and `railway.json` and starts a first build. **That first build will fail to start**, because the database isn't connected yet. That's expected.
3. **Use the right branch.** Until the code is merged to `main`: open the new service → **Settings → Source → Branch**, and choose `claude/aba-app-v1`.
4. **Add the database.** In the project canvas click **+ New → Database → PostgreSQL**. Wait until it shows as running.
5. **Set the app's variables.** Open the app service (not the database) → **Variables**, and add:

   | Name | Value |
   |---|---|
   | `DATABASE_ADMIN_URL` | `${{Postgres.DATABASE_URL}}` (type it exactly; Railway fills in the real value) |
   | `DEMO_PASSWORD` | A password you choose, **at least 12 characters**. Everyone signs in with this. Shorter passwords stop the app at startup. |

   If your database service has a different name than `Postgres`, use that name instead, e.g. `${{postgres-db.DATABASE_URL}}`.

   Railway may also suggest or import variables from the project's `.env.example` (`DATABASE_URL`, `DIRECT_DATABASE_URL`, `SESSION_SECRET`, `TEST_…`, `LLM_…`). **Delete them**: the demo works them out itself and ignores the local-development values.
6. **Give it a web address.** App service → **Settings → Networking → Generate Domain**. Railway gives you a link like `aba-app-production.up.railway.app`. If it asks for a port, use the one the app reports in its deploy logs (`[demo-start] starting app on port …`, usually `8080`). If the link shows **"Application failed to respond"** while the service is Online, the ports don't match: click the pencil next to the domain and set it to the port from the logs.
7. **Deploy.** Saving variables usually triggers a new deploy; if not, click **Deploy**. The first boot takes a few minutes: it builds the app, sets up the database, and loads the fictional clients. When the service shows **Active**, open the link.

## Signing in

| Who | Email | What they can do |
|---|---|---|
| Amoy (BCBA) | `bcba@sample-practice.test` | Everything: drafting, approving, exporting |
| Auth coordinator | `coordinator@sample-practice.test` | Documents, letters, packets |
| RBT | `rbt@sample-practice.test` | Read clients, enter data only |
| Parent | `parent@sample-practice.test` | Sign assigned documents only |

- Password: your `DEMO_PASSWORD` for every account.
- **First sign-in:** the app shows a QR code. Scan it with an authenticator app (Google Authenticator, Microsoft Authenticator, or the iPhone Passwords app), then type the 6-digit code. After that, each sign-in asks for the current code from that app.
- **One person per account.** The first person to finish the QR setup owns that account's authenticator; anyone else trying the same account is told it was already set up. Amoy uses the BCBA account; use the coordinator or RBT account to see the app from another role.
- Lost a phone, or someone else claimed the account? See "Reset one person's authenticator" below.

## Things to try

- **Caseload:** what's due in the next 60 days, and alerts.
- **Clients → Charlie:** caregiver-training shortfall, supervision alert, and a bolting safety flag.
- **Clients → Bravo → New reauth plan:** "Draft with AI" on a section. Tap a highlighted number to see where it came from. Mark the required items, then approve the section.
- **VB-MAPP page:** load a sample workbook to see the import review and its flags.
- **Packet page:** load a sample payor letter, confirm it, and see export stay blocked until everything is approved.
- **Payor rules:** each rule's source and its verified/unverified status.

The AI is a built-in stand-in (no real AI calls, no cost). To try real Claude drafting on the fictional clients, add `LLM_PROVIDER=anthropic`, `LLM_MODEL=claude-opus-5-5`, and `ANTHROPIC_API_KEY` to the app's variables.

## Maintenance

- **Change the password:** edit `DEMO_PASSWORD` and let it redeploy. The new password works and the old one stops working; everyone is signed out.
- **Reset one person's authenticator:** add `RESET_MFA` with the account email (or several, comma-separated, or `all`), let it redeploy, then **delete the variable**. That person sees the QR setup again at their next sign-in.
- **Start over with fresh fictional data:** add `RESEED=true`, let it redeploy, then **delete the variable** (otherwise every restart resets the data). This also resets everyone's authenticator.
- **The demo's "today":** the fictional clients' dates are relative to the day they were loaded, so the app keeps its date fixed to that day (shown in the logs as `demo date is …`). Reseed to move it to the current date.
- **Exported PDFs** are kept only until the app restarts or redeploys; export again if a download says the file is gone.
- **New code:** Railway redeploys automatically when the branch changes.
- **Something broke:** open the app service → **Deployments → View logs**, and send the lines that start with `[demo-start]` or say `Error`.
