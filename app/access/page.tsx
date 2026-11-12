"use client";

import { FormEvent, useState } from "react";

export default function AccessPage() {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!code.trim() || checking) return;
    setChecking(true);
    setError("");
    try {
      const res = await fetch("/api/access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (res.ok) {
        window.location.href = "/"; // full reload so the new pass is used straight away
        return;
      }
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Something went wrong. Please try again.");
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
    }
    setChecking(false);
  }

  return (
    <main className="access">
      <form className="access-card" onSubmit={submit}>
        <h1>Travel Planner</h1>
        <p>Enter your access code to continue.</p>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          aria-label="Access code"
          placeholder="Access code"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={32}
          autoFocus
        />
        {error && (
          <p className="access-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" disabled={checking || !code.trim()}>
          {checking ? "Checking…" : "Enter"}
        </button>
      </form>
    </main>
  );
}
