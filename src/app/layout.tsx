import type { Metadata } from "next";
import { cookies } from "next/headers";
import "@fontsource/poppins/400.css";
import "@fontsource/poppins/500.css";
import "@fontsource/poppins/600.css";
import "@fontsource/poppins/700.css";
import { getSessionByToken, SESSION_COOKIE } from "@/lib/auth/session";
import { LogoutButton } from "@/components/actions";
import { AppShell } from "@/components/app-shell";
import { label } from "@/components/labels";
import { Lion } from "@/components/lion";
import { APP_NAME, APP_TAGLINE } from "@/lib/brand";
import { db } from "@/lib/db";
import { isDemo } from "@/lib/demo";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: APP_NAME, template: `%s · ${APP_NAME}` },
  description: `${APP_TAGLINE} (synthetic data only)`,
};
export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await getSessionByToken((await cookies()).get(SESSION_COOKIE)?.value);
  const demo = isDemo();
  if (!session?.orgId)
    return (
      <html lang="en">
        <body>
          <div className="bare">
            <div className="bare-inner">
              <div className="brand">
                <Lion size={52} />
                {APP_NAME}
              </div>
              {children}
              <p className="muted" style={{ textAlign: "center", marginTop: 16 }}>
                {demo
                  ? "Demo site with fictional clients only. Never enter real client information."
                  : "Synthetic data only. Do not enter real client information."}
              </p>
            </div>
          </div>
        </body>
      </html>
    );
  // Identity rows are global (no org data): only the display name is read.
  const user = await db().user.findUnique({ where: { id: session.userId }, select: { name: true } });
  return (
    <html lang="en">
      <body>
        <AppShell
          user={{ name: user?.name ?? "Signed in", role: label(session.role) }}
          bcba={session.role === "BCBA"}
          demo={demo}
          logout={<LogoutButton />}
        >
          {children}
        </AppShell>
      </body>
    </html>
  );
}
