import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { getSessionByToken, SESSION_COOKIE } from "@/lib/auth/session";
import { LogoutButton } from "@/components/actions";
import { isDemo } from "@/lib/demo";
import "./globals.css";

export const metadata: Metadata = {
  title: "ABA Plan Assistant",
  description: "Treatment plan and reauthorization assistant (synthetic data only)",
};
export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await getSessionByToken((await cookies()).get(SESSION_COOKIE)?.value);
  return (
    <html lang="en">
      <body>
        <div className="synthetic-banner">
          {isDemo()
            ? "Demo site with fictional clients only. Never enter or upload real client information here."
            : "v1.0 local build: synthetic data only. Do not enter real client information."}
        </div>
        <header className="top">
          <span className="brand">ABA Plan Assistant</span>
          {session?.orgId && (
            <>
              <nav>
                <Link href="/">Caseload</Link>
                <Link href="/clients">Clients</Link>
                <Link href="/payors">Payor rules</Link>
                {session.role === "BCBA" && <Link href="/audit">Audit log</Link>}
                {session.role === "BCBA" && <Link href="/settings">Settings</Link>}
              </nav>
              <span className="muted" style={{ marginLeft: "auto" }}>
                Role: {session.role}
              </span>
              <LogoutButton />
            </>
          )}
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
