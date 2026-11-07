"use client";

import { useState } from "react";

type Step = "password" | "newPassword" | "mfa" | "enroll";

export function LoginForm({ demo, notice }: { demo: boolean; notice?: string | null }) {
  const [step, setStep] = useState<Step>("password");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [enroll, setEnroll] = useState<{ secret: string; otpauthUrl: string; qrSvg: string } | null>(null);
  const [temporary, setTemporary] = useState("");

  async function post(url: string, body: unknown) {
    setBusy(true);
    setError(null);
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(data.error ?? "Sign-in failed");
      // The sign-in ended (for example the account locked): start again from the password.
      if (data.restart) {
        setEnroll(null);
        setStep("password");
      }
    }
    return res.ok ? data : null;
  }

  async function afterPassword(mfaEnrolled: boolean) {
    if (mfaEnrolled) return setStep("mfa");
    const en = await post("/api/auth/mfa/enroll", {});
    if (en) {
      setEnroll(en);
      setStep("enroll");
    }
  }

  const codeForm = (url: string, label: string) => (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        if (await post(url, { code: String(f.get("code")).trim() })) window.location.href = "/";
      }}
    >
      <label htmlFor="code">{label}</label>
      <input
        id="code"
        name="code"
        inputMode="numeric"
        pattern="\d{6}"
        autoComplete="one-time-code"
        required
      />
      <p>
        <button disabled={busy}>Verify</button>
      </p>
    </form>
  );

  return (
    <div className="panel" style={{ maxWidth: 440, margin: "40px auto" }}>
      <h1>Sign in</h1>
      {notice && !error && step === "password" && (
        <p className="notice" role="status" data-testid="login-notice">
          {notice}
        </p>
      )}
      {step === "password" && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const r = await post("/api/auth/login", { email: f.get("email"), password: f.get("password") });
            if (!r) return;
            if (r.mustChangePassword) {
              setTemporary(String(f.get("password")));
              return setStep("newPassword");
            }
            await afterPassword(r.mfaEnrolled);
          }}
        >
          <label htmlFor="email">Email</label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            required
            style={{ width: "100%" }}
          />
          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            style={{ width: "100%" }}
          />
          <p>
            <button disabled={busy}>Continue</button>
          </p>
        </form>
      )}
      {step === "newPassword" && (
        <form
          data-testid="new-password-form"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const next = String(f.get("newPassword"));
            if (next !== String(f.get("confirmPassword"))) return setError("The two passwords do not match.");
            const r = await post("/api/auth/password", { currentPassword: temporary, newPassword: next });
            if (!r) return;
            setTemporary("");
            await afterPassword(r.mfaEnrolled);
          }}
        >
          <p>
            <strong>Choose your own password.</strong> The password you were given is temporary and stops
            working once you choose yours. Only you should know it.
          </p>
          <label htmlFor="newPassword">New password (at least 12 characters)</label>
          <input
            id="newPassword"
            name="newPassword"
            type="password"
            autoComplete="new-password"
            minLength={12}
            required
            style={{ width: "100%" }}
          />
          <label htmlFor="confirmPassword">Type it again</label>
          <input
            id="confirmPassword"
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
            minLength={12}
            required
            style={{ width: "100%" }}
          />
          <p>
            <button disabled={busy}>Save password</button>
          </p>
        </form>
      )}
      {step === "mfa" && (
        <>
          {codeForm("/api/auth/mfa", "Authenticator code")}
          <p className="muted">
            Enter the 6-digit code from your authenticator app.
            {!demo && (
              <>
                {" "}
                Local demo: run <code>pnpm totp</code>.
              </>
            )}
          </p>
        </>
      )}
      {step === "enroll" && enroll && (
        <>
          <p>
            <strong>Set up two-step sign-in.</strong> Scan this with an authenticator app (Google
            Authenticator, Microsoft Authenticator, or your phone&apos;s password app), then enter the 6-digit
            code it shows.
          </p>
          <div
            data-testid="mfa-qr"
            style={{ background: "#fff", display: "inline-block", padding: 8, borderRadius: 6 }}
            dangerouslySetInnerHTML={{ __html: enroll.qrSvg }}
          />
          <p className="muted">
            On this phone? <a href={enroll.otpauthUrl}>Open in your authenticator app</a>, or type this key:{" "}
            <code data-testid="mfa-secret">{enroll.secret.replace(/(.{4})/g, "$1 ").trim()}</code>
          </p>
          {codeForm("/api/auth/mfa/confirm", "Code from your authenticator app")}
        </>
      )}
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
