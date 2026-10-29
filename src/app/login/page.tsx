"use client";

import { useState } from "react";

type Step = "password" | "mfa" | "enroll";

export default function LoginPage() {
  const [step, setStep] = useState<Step>("password");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [enroll, setEnroll] = useState<{ secret: string; otpauthUrl: string; qrSvg: string } | null>(null);

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
    if (!res.ok) setError(data.error ?? "Sign-in failed");
    return res.ok ? data : null;
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
      {step === "password" && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const r = await post("/api/auth/login", { email: f.get("email"), password: f.get("password") });
            if (!r) return;
            if (r.mfaEnrolled) return setStep("mfa");
            const en = await post("/api/auth/mfa/enroll", {});
            if (en) {
              setEnroll(en);
              setStep("enroll");
            }
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
      {step === "mfa" && (
        <>
          {codeForm("/api/auth/mfa", "Authenticator code")}
          <p className="muted">Enter the 6-digit code from your authenticator app.</p>
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
