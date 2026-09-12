import { useEffect, useState } from "react";
import { backend } from "../lib/backendClient.js";

// Challenges expire on a wall-clock timer (CHALLENGE_TTL_MS in
// backendClient.js), not on a call into the canister — nothing "happens" at
// the exact expiry moment for backend._subscribe to notify about. So this
// page still re-derives display status once a second purely to catch that
// clock ticking past expiresAt; every other field (identityRoot, challenge
// creation/verification, nullifier count) updates instantly via
// backend._subscribe the moment it actually changes on the canister object.
function withLiveStatus(state) {
  const now = Date.now();
  const challenges = Object.fromEntries(
    Object.entries(state.challenges).map(([id, ch]) => [
      id,
      ch.status === "Pending" && now > ch.expiresAt ? { ...ch, status: "Expired" } : ch,
    ])
  );
  return { ...state, challenges };
}

export default function StatusPage() {
  const [state, setState] = useState(() => withLiveStatus(backend._debugState()));

  useEffect(() => {
    const unsubscribe = backend._subscribe((next) => setState(withLiveStatus(next)));
    // Only for the expiry clock described above — every other change here
    // is pushed the instant it happens, not waited-for.
    const tick = setInterval(() => setState(withLiveStatus(backend._debugState())), 1000);
    return () => {
      unsubscribe();
      clearInterval(tick);
    };
  }, []);

  const challenges = Object.entries(state.challenges);

  return (
    <div className="main">
      <div className="card">
        <h2>Canister status — live (Mock canister, local to this tab)</h2>
        <p className="lead">
          This is the actual, current state of this demo's backend canister
          object — the same one <code>CitizenPage</code> and{" "}
          <code>CompanyPage</code> read and write through{" "}
          <code>backendClient.js</code> — not a separate display copy. It
          updates the instant a call changes it. It is still a{" "}
          <strong>mock canister confined to this browser tab</strong>, not a
          deployed THEBES canister: no network calls leave this page. Once
          this project is actually deployed and <code>backendClient.js</code>{" "}
          is swapped for real actor calls (see its header comment), this
          same panel would show the real canister's state instead.
        </p>
        <dl className="kv">
          <dt>identityRoot</dt>
          <dd>{state.identityRoot ?? "— not published yet —"}</dd>
          <dt>Nullifiers consumed</dt>
          <dd>{state.nullifiersConsumed}</dd>
        </dl>
      </div>

      <div className="card">
        <h2>Challenges</h2>
        {challenges.length === 0 && <p className="lead">No Challenge has been created yet.</p>}
        {challenges.map(([id, ch]) => (
          <div key={id} className="mono-block" style={{ marginBottom: 10 }}>
            {id} — {ch.companyName} — <strong>{ch.status}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}
