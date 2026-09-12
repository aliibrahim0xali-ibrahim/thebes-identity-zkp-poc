import { useEffect, useState } from "react";
import Banner from "../components/Banner.jsx";
import { backend } from "../lib/backendClient.js";
import { generateProof, loadMockRegistry } from "../lib/zk.js";
import { passkeysSupported, passkeySignIn, devModeSignIn, citizenIndexForSession } from "../lib/auth.js";

const CURRENT_YEAR = new Date().getFullYear();

function todayAsYyyymmdd() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return Number(`${d.getFullYear()}${mm}${dd}`);
}
const CURRENT_DATE = todayAsYyyymmdd();

// Challenge ids are 16 random bytes hex-encoded by backendClient.js'
// randomChallengeId() — so "hexadecimal, even length, non-empty" is the
// actual expected shape, not an arbitrary rule.
const HEX_RE = /^[0-9a-fA-F]+$/;

function challengeIdError(value) {
  const v = value.trim();
  if (!v) return null; // empty: just disable submit, don't shout an error yet
  if (!HEX_RE.test(v)) return "Challenge ID must be hexadecimal (0-9, a-f only).";
  if (v.length % 2 !== 0) return "Challenge ID must have an even number of hex digits.";
  return null;
}

export default function CitizenPage() {
  const [registry, setRegistry] = useState(null);
  const [citizenIndex, setCitizenIndex] = useState(0);
  const [challengeId, setChallengeId] = useState("");
  const [phase, setPhase] = useState("idle"); // idle | proving | done | error
  const [result, setResult] = useState(null);

  // Sign-in state, separate from the proving flow above.
  const [session, setSession] = useState(null); // { credentialId, mode: "passkey" | "dev" }
  const [signInError, setSignInError] = useState(null);
  const [signingIn, setSigningIn] = useState(false);

  useEffect(() => {
    loadMockRegistry().then(setRegistry);
  }, []);

  const citizen = registry?.citizens?.[citizenIndex];

  async function handleSignIn() {
    setSignInError(null);
    setSigningIn(true);
    try {
      let credentialId;
      let mode;
      if (passkeysSupported()) {
        try {
          credentialId = await passkeySignIn();
          mode = "passkey";
        } catch (err) {
          // Origin pinning (e.g. localhost) or a cancelled ceremony — fall
          // back to dev mode rather than dead-ending the demo, but say so.
          credentialId = devModeSignIn();
          mode = "dev";
        }
      } else {
        credentialId = devModeSignIn();
        mode = "dev";
      }

      if (registry) {
        const idx = await citizenIndexForSession(credentialId, registry);
        setCitizenIndex(idx);
      }
      setSession({ credentialId, mode });
    } catch (err) {
      setSignInError(String(err?.message || err));
    } finally {
      setSigningIn(false);
    }
  }

  const challengeError = challengeIdError(challengeId);

  async function handleProve(e) {
    e.preventDefault();
    setResult(null);
    // Belt-and-suspenders: even though the form is unmounted (not just
    // disabled) until sign-in, and the submit button is disabled while the
    // Challenge ID is invalid, guard here too so this function can never
    // run against an unauthenticated session or a malformed id if it's
    // ever called some other way (e.g. programmatically).
    if (!session) return;
    if (!challengeId.trim() || challengeIdError(challengeId)) return;
    const root = await backend.getIdentityRoot();
    if (!root) {
      setPhase("error");
      setResult({ ok: false, message: "The identity root hasn't been published yet — open the \"Company & Verify\" tab first (or wait for auto-registration)." });
      return;
    }

    try {
      setPhase("proving");
      const { proof, publicSignals, nullifier, outRoot } = await generateProof({
        citizen,
        merkleRoot: root,
        currentYear: CURRENT_YEAR,
        currentDate: CURRENT_DATE,
        challengeId: challengeId.trim(),
      });

      if (outRoot !== root) {
        setPhase("error");
        setResult({ ok: false, message: "The tree root in the proof does not match the root published on the canister." });
        return;
      }

      setPhase("done");
      setResult({
        ok: true,
        message: "Proof generated locally in your browser. Nothing has been sent to the canister yet — copy the proof payload and hand it to the company's verification page, which will consume the Challenge/nullifier only once, at the moment it verifies.",
        nullifier,
        proofPayload: JSON.stringify({ proof, publicSignals }, null, 2),
      });
    } catch (err) {
      setPhase("error");
      const msg = String(err?.message || err);
      const isConstraintFail = /Error in template IdentityCredential|Assert Failed/i.test(msg);
      setResult({
        ok: false,
        message: isConstraintFail
          ? "Could not generate the proof: one of the attested facts (18+, or ID not expired) doesn't hold for this person. This is expected if you picked a minor or an expired-ID citizen."
          : `Could not generate the proof: ${msg}`,
      });
    }
  }

  return (
    <div className="main">
      <div className="card">
        <h2>Sign in (Passkey)</h2>
        <p className="lead">
          Same login concept as the rest of the THEBES apps: a real WebAuthn
          passkey ceremony opens your session — no password, no identity
          data typed in. Passkeys are pinned to the origin they're created
          on, so on <code>localhost</code> (or a browser without passkey
          support) this automatically falls back to a labeled dev-mode
          session instead of dead-ending the demo; test the real ceremony
          once this is deployed to its own <code>*.mercaturaforum.com</code>{" "}
          URL.
        </p>

        {!session ? (
          <div className="row">
            <button className="primary" type="button" onClick={handleSignIn} disabled={signingIn}>
              {signingIn ? "Signing in…" : "Sign in with passkey"}
              {signingIn && <span className="spinner" />}
            </button>
          </div>
        ) : (
          <>
            <Banner kind="ok">
              Signed in ({session.mode === "passkey" ? "passkey" : "dev mode — no real passkey ceremony available on this origin"}).
              This session is linked to <strong>{citizen?.label ?? "…"}</strong>, an identity already
              enrolled in this demo's Merkle tree — its Poseidon commitment
              was already built into the published root, exactly as if an
              institution had verified and registered it before you ever
              signed in. You're ready to answer a Challenge from any company
              in the "Company & Verify" tab.
            </Banner>
            <p className="footnote" style={{ marginTop: 8 }}>
              This link is deterministic per passkey (never a minor row) and
              stays confined to this demo's own mock canister/root — it
              can't make a real, external verifier treat anyone as
              authority-checked.
            </p>
          </>
        )}
        {signInError && <Banner kind="err">Could not sign in: {signInError}</Banner>}
      </div>

      {!session ? (
        <div className="card">
          <h2>Request a proof for a company</h2>
          <p className="lead">Sign in above to unlock this section.</p>
        </div>
      ) : (
        <>
          <form className="card" onSubmit={handleProve}>
            <h2>Request a proof for a company</h2>
            <p className="lead">
              Paste the Challenge code the company gave you, and your wallet
              (the browser) will generate a real zk-SNARK proof attesting
              that you're a member of the identity tree, an Egyptian citizen,
              18 or older, and hold a digital ID card that has not expired —
              bound to this specific Challenge — without ever revealing your
              date of birth, your ID card number, or its exact expiry date.
            </p>
            <p className="footnote" style={{ marginTop: -4, marginBottom: 12 }}>
              Note: the identity shown above (<strong>{citizen?.label ?? "…"}</strong>,
              its birth-year bucket, ID number, and ID expiry date) is mock
              demo data standing in for a real citizen record — it exists
              only in this project's <code>mock_registry.json</code>. The
              Challenge/nullifier handling below it runs against the real
              backend state machine (mirrored in <code>backendClient.js</code>{" "}
              from <code>main.mo</code>), so the accept/reject/replay
              behavior you see is not simulated.
            </p>
            <div className="field">
              <label>Challenge ID (hexadecimal)</label>
              <input
                value={challengeId}
                onChange={(e) => setChallengeId(e.target.value)}
                placeholder="Paste the hex code from the “Company & Verify” tab"
                inputMode="text"
                pattern="[0-9a-fA-F]*"
                aria-invalid={!!challengeError}
              />
              {challengeError && (
                <p className="footnote" style={{ color: "var(--err, #c0392b)", marginTop: 4 }}>
                  {challengeError}
                </p>
              )}
            </div>
            <div className="row">
              <button
                className="primary"
                type="submit"
                disabled={phase === "proving" || !challengeId.trim() || !!challengeError}
              >
                {phase === "proving" ? "Generating proof…" : "Generate proof"}
                {phase === "proving" && <span className="spinner" />}
              </button>
            </div>

            {result && (
              <Banner kind={result.ok ? "ok" : "err"}>{result.message}</Banner>
            )}

            {result?.nullifier && (
              <div style={{ marginTop: 16 }}>
                <dl className="kv">
                  <dt>nullifier</dt>
                  <dd>{result.nullifier}</dd>
                </dl>
                <div className="field" style={{ marginTop: 12 }}>
                  <label>Proof payload (hand this to the company's verification page)</label>
                  <textarea
                    readOnly
                    value={result.proofPayload}
                    onFocus={(e) => e.target.select()}
                    style={{
                      width: "100%", minHeight: 140, background: "var(--ink)",
                      color: "var(--parchment)", fontFamily: "var(--font-mono)",
                      fontSize: "0.75rem", border: "1px solid var(--ink-line)",
                      borderRadius: 8, padding: 10,
                    }}
                  />
                </div>
              </div>
            )}
          </form>

          <p className="footnote">
            Every computation here actually happens inside the browser (WASM +
            Groth16 via snarkjs) — no server ever sees your birthYear, ID
            number, ID expiry date, or salt. Only the root, the Challenge,
            and today's date (year and full date) ever leave this page.
          </p>
        </>
      )}
    </div>
  );
}
