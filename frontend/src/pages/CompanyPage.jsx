import { useState } from "react";
import Banner from "../components/Banner.jsx";
import { backend } from "../lib/backendClient.js";
import { verifyProof, challengeToField } from "../lib/zk.js";

const textareaStyle = {
  width: "100%", minHeight: 140, background: "var(--ink)",
  color: "var(--parchment)", fontFamily: "var(--font-mono)",
  fontSize: "0.75rem", border: "1px solid var(--ink-line)",
  borderRadius: 8, padding: 10,
};

export default function CompanyPage() {
  const [companyName, setCompanyName] = useState("Acme Bank");
  const [createdChallenge, setCreatedChallenge] = useState(null);

  const [verifyChallengeId, setVerifyChallengeId] = useState("");
  const [proofText, setProofText] = useState("");
  const [verifyPhase, setVerifyPhase] = useState("idle"); // idle | checking | done
  const [verifyResult, setVerifyResult] = useState(null);

  async function handleCreateChallenge(e) {
    e.preventDefault();
    const id = await backend.createChallenge(companyName.trim() || "Unnamed Company");
    setCreatedChallenge(id);
  }

  async function handleVerify(e) {
    e.preventDefault();
    setVerifyResult(null);
    setVerifyPhase("checking");
    try {
      const parsed = JSON.parse(proofText);
      const { proof, publicSignals } = parsed;
      if (!proof || !publicSignals) throw new Error("Proof payload is incomplete (needs proof and publicSignals)");

      const [nullifier, , outRoot, outChallenge] = publicSignals;

      const challenge = await backend.getChallenge(verifyChallengeId.trim());
      if (!challenge) {
        setVerifyPhase("done");
        setVerifyResult({ ok: false, message: "This code is unknown to the canister — no such Challenge." });
        return;
      }

      if (challenge.status === "Verified") {
        setVerifyPhase("done");
        setVerifyResult({
          ok: false,
          message: "This Challenge was already used for a successful verification — each Challenge is single-use. Create a new Challenge in step 1 for another attempt.",
        });
        return;
      }
      if (challenge.status === "Expired" || Date.now() > challenge.expiresAt) {
        setVerifyPhase("done");
        setVerifyResult({ ok: false, message: "This Challenge expired (10-minute limit) — create a new one in step 1." });
        return;
      }

      const expectedField = challengeToField(verifyChallengeId.trim());
      if (outChallenge !== expectedField) {
        setVerifyPhase("done");
        setVerifyResult({ ok: false, message: "This proof was not built for this Challenge — rejected." });
        return;
      }

      const root = await backend.getIdentityRoot();
      if (outRoot !== root) {
        setVerifyPhase("done");
        setVerifyResult({ ok: false, message: "The identity tree root in the proof does not match the root published on the canister." });
        return;
      }

      const cryptoOk = await verifyProof(proof, publicSignals);
      if (!cryptoOk) {
        setVerifyPhase("done");
        setVerifyResult({ ok: false, message: "The Groth16 proof failed cryptographic verification." });
        return;
      }

      const consumeRes = await backend.consumeNullifier(verifyChallengeId.trim(), nullifier);
      setVerifyPhase("done");
      if (consumeRes.ok) {
        setVerifyResult({
          ok: true,
          message: "Identity verified ✅ — this person is a registered member of the identity tree and is 18 or older, nothing else.",
          verifiedAt: new Date().toISOString(),
        });
      } else {
        const reasonMessages = {
          NullifierAlreadyUsed: "This proof was already consumed — replay rejected.",
          ChallengeNotPending: "This Challenge was already used (or is no longer pending) — each Challenge is single-use. Create a new one in step 1.",
          ChallengeExpired: "This Challenge expired (10-minute limit) — create a new one in step 1.",
          UnknownChallenge: "This code is unknown to the canister — no such Challenge.",
        };
        setVerifyResult({
          ok: false,
          message: reasonMessages[consumeRes.reason] ?? `Rejected: ${consumeRes.reason}`,
        });
      }
    } catch (err) {
      setVerifyPhase("done");
      setVerifyResult({ ok: false, message: `Could not read/verify the proof: ${String(err.message || err)}` });
    }
  }

  return (
    <div className="main">
      <form className="card" onSubmit={handleCreateChallenge}>
        <h2>1) Request a proof (Challenge)</h2>
        <p className="lead">
          Before asking any citizen for a proof, ask the canister for a
          code that's valid for only 10 minutes. Hand this code to the
          citizen (a link or QR code in a real system).
        </p>
        <div className="field">
          <label>Company name</label>
          <input value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
        </div>
        <button className="primary" type="submit">Create Challenge</button>
        {createdChallenge && (
          <div style={{ marginTop: 14 }}>
            <dl className="kv">
              <dt>challengeId</dt>
              <dd>{createdChallenge}</dd>
            </dl>
          </div>
        )}
      </form>

      <form className="card" onSubmit={handleVerify}>
        <h2>2) Public verification page</h2>
        <p className="lead">
          Open to anyone without sign-in: its only inputs are the
          Challenge and the proof payload. The output is either
          "Identity verified ✅" or the reason for rejection — no extra
          personal data involved.
        </p>
        <div className="field">
          <label>Challenge ID</label>
          <input value={verifyChallengeId} onChange={(e) => setVerifyChallengeId(e.target.value)} placeholder="From step 1" />
        </div>
        <div className="field">
          <label>Proof payload (JSON)</label>
          <textarea
            style={textareaStyle}
            value={proofText}
            onChange={(e) => setProofText(e.target.value)}
            placeholder='{"proof": {...}, "publicSignals": [...]}'
          />
        </div>
        <button className="primary" type="submit" disabled={verifyPhase === "checking"}>
          {verifyPhase === "checking" ? "Verifying…" : "Verify"}
          {verifyPhase === "checking" && <span className="spinner" />}
        </button>

        {verifyResult && (
          <Banner kind={verifyResult.ok ? "ok" : "err"}>{verifyResult.message}</Banner>
        )}
      </form>
    </div>
  );
}
