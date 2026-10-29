"use client";

import { useState } from "react";

export default function LoginPage() {
  const [step, setStep] = useState<"password" | "mfa">("password");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
    return res.ok;
  }

  return (
    <div className="panel" style={{ maxWidth: 420, margin: "40px auto" }}>
      <h1>Sign in</h1>
      {step === "password" ? (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            if (await post("/api/auth/login", { email: f.get("email"), password: f.get("password") }))
              setStep("mfa");
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
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            if (await post("/api/auth/mfa", { code: String(f.get("code")).trim() }))
              window.location.href = "/";
          }}
        >
          <label htmlFor="code">Authenticator code</label>
          <input
            id="code"
            name="code"
            inputMode="numeric"
            pattern="\d{6}"
            autoComplete="one-time-code"
            required
          />
          <p className="muted">
            Enter the 6-digit code from your authenticator app. Local demo: run <code>pnpm totp</code>.
          </p>
          <p>
            <button disabled={busy}>Verify</button>
          </p>
        </form>
      )}
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
