// run_demo_v2.js
//
// End-to-end demo of the CHALLENGE-BOUND identity flow discussed for THEBES:
//
//   1) MOCK INSTITUTION  -> enrolls N citizens into a Poseidon Merkle tree,
//                            publishes only the root (build_mock_registry.js).
//                            This stands in for the future step where a real
//                            institution verifies uploaded ID+selfie data and
//                            registers the result on the THEBES canister.
//   2) COMPANY            -> issues a single-use challenge (this is
//                            issuer_registry.mo's createChallenge()).
//   3) CITIZEN'S WALLET   -> logs in with passkey (out of scope for this JS
//                            demo — assumed already done), then builds ONE
//                            zk-SNARK proving: "I am one of the enrolled
//                            citizens AND I am >=18", bound to that exact
//                            challenge. Nothing else is revealed.
//   4) COMPANY VERIFIES   -> checks the proof, that merkleRoot matches the
//                            canister's published root, that the challenge
//                            matches what it issued, and that the nullifier
//                            has never been consumed before (replay guard —
//                            this is issuer_registry.mo's consumeNullifier()).
//
// Everything here runs locally against the compiled circuit; a real
// deployment replaces steps (1) and (2)/(4)'s bookkeeping with actual calls
// to the THEBES canister in contracts/issuer_registry.mo.

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const snarkjs = require("snarkjs");
const { buildPoseidon } = require("circomlibjs");

const BUILD_DIR = path.join(__dirname, "..", "build_v2");
const REGISTRY_PATH = path.join(BUILD_DIR, "mock_registry.json");
const CURRENT_YEAR = 2026n;

// Mimics issuer_registry.mo's in-memory state for this demo run.
const canisterMock = {
  identityRoot: null,
  usedNullifiers: new Set(),
  challenges: new Map(), // challengeId -> { companyName, status }

  registerIdentityRoot(root) {
    this.identityRoot = root;
    console.log(`[canister] identityRoot registered: ${root}`);
  },

  createChallenge(companyName) {
    const id = crypto.randomBytes(16).toString("hex");
    this.challenges.set(id, { companyName, status: "Pending" });
    console.log(`[canister] createChallenge("${companyName}") -> ${id}`);
    return id;
  },

  // What consumeNullifier(challengeId, nullifier) would do on-chain.
  consumeNullifier(challengeId, nullifier) {
    const ch = this.challenges.get(challengeId);
    if (!ch) return { ok: false, reason: "unknown challenge" };
    if (ch.status !== "Pending") return { ok: false, reason: `challenge is ${ch.status}, not Pending` };
    if (this.usedNullifiers.has(nullifier)) return { ok: false, reason: "nullifier already used (replay)" };

    this.usedNullifiers.add(nullifier);
    ch.status = "Verified";
    return { ok: true };
  },
};

async function proveAndVerify({ citizen, challenge, expectAccept }) {
  const wasmPath = path.join(BUILD_DIR, "identity_proof_js", "identity_proof.wasm");
  const zkeyPath = path.join(BUILD_DIR, "identity_proof_final.zkey");
  const vkeyPath = path.join(BUILD_DIR, "verification_key.json");
  const vkey = JSON.parse(fs.readFileSync(vkeyPath));

  const challengeField = BigInt("0x" + Buffer.from(challenge, "hex").toString("hex")).toString();

  const input = {
    birthYear: citizen.birthYear,
    salt: citizen.salt,
    pathIndices: citizen.pathIndices,
    pathElements: citizen.pathElements,
    currentYear: CURRENT_YEAR.toString(),
    merkleRoot: canisterMock.identityRoot,
    challenge: challengeField,
  };

  try {
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasmPath, zkeyPath);
    if (!expectAccept) {
      console.log("  UNEXPECTED: proof should not have been constructible for this citizen.");
      return null;
    }

    // publicSignals order follows the circuit's `public [...]` + outputs:
    // [nullifier, currentYear, merkleRoot, challenge] for this compiled circuit.
    const [nullifier, outCurrentYear, outRoot, outChallenge] = publicSignals;

    console.log(`  proof generated (${JSON.stringify(proof).length} bytes)`);
    console.log(`  public signals -> currentYear=${outCurrentYear}, merkleRoot matches: ${outRoot === canisterMock.identityRoot}, nullifier=${nullifier.slice(0, 16)}...`);

    const cryptoOk = await snarkjs.groth16.verify(vkey, publicSignals, proof);
    if (!cryptoOk) {
      console.log("  REJECTED: SNARK verification failed.");
      return null;
    }
    if (outRoot !== canisterMock.identityRoot) {
      console.log("  REJECTED: merkleRoot in the proof does not match the canister's published root.");
      return null;
    }
    if (outChallenge !== challengeField) {
      console.log("  REJECTED: proof was not built for this challenge.");
      return null;
    }

    console.log("  ACCEPTED cryptographically. Asking the canister to consume the nullifier...");
    return nullifier;
  } catch (e) {
    if (expectAccept) {
      console.log("  UNEXPECTED FAILURE:", e.message);
      return null;
    }
    console.log("  As expected: the circuit refuses to produce a proof (age constraint unsatisfied).");
    return null;
  }
}

async function main() {
  if (!fs.existsSync(REGISTRY_PATH)) {
    console.log("No mock registry found — run `node scripts/build_mock_registry.js` first.\n");
    process.exit(1);
  }
  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH));

  console.log("== 1) Mock institution publishes the identity root ==");
  canisterMock.registerIdentityRoot(registry.root);
  console.log();

  // ---------- Scenario A: adult citizen, first use of a fresh challenge ----------
  console.log("== 2) A company requests proof of age from citizen_0 (adult) ==");
  const challengeA = canisterMock.createChallenge("Acme Bank");
  const citizen0 = registry.citizens[0]; // adult
  console.log("\n== 3) citizen_0's wallet builds a proof bound to this challenge ==");
  const nullifierA = await proveAndVerify({ citizen: citizen0, challenge: challengeA, expectAccept: true });
  if (nullifierA) {
    const res = canisterMock.consumeNullifier(challengeA, nullifierA);
    console.log("  [canister] consumeNullifier ->", res);
  }
  console.log();

  // ---------- Scenario B: REPLAY — same proof/nullifier reused on the same challenge ----------
  console.log("== 4) Someone replays the SAME proof against the SAME challenge ==");
  if (nullifierA) {
    const res = canisterMock.consumeNullifier(challengeA, nullifierA);
    console.log("  [canister] consumeNullifier ->", res, "(must be rejected)");
  }
  console.log();

  // ---------- Scenario C: same citizen, a DIFFERENT company/challenge ----------
  console.log("== 5) A different company issues its OWN challenge to the same citizen ==");
  const challengeB = canisterMock.createChallenge("Beta Insurance");
  const nullifierB = await proveAndVerify({ citizen: citizen0, challenge: challengeB, expectAccept: true });
  if (nullifierB) {
    console.log(`  nullifier for Acme Bank : ${nullifierA.slice(0, 16)}...`);
    console.log(`  nullifier for Beta Ins. : ${nullifierB.slice(0, 16)}...`);
    console.log("  different and unlinkable, even though it's the same citizen ->", nullifierA !== nullifierB);
    const res = canisterMock.consumeNullifier(challengeB, nullifierB);
    console.log("  [canister] consumeNullifier ->", res);
  }
  console.log();

  // ---------- Scenario D: negative control — a minor tries to prove age >= 18 ----------
  console.log("== 6) Negative control: citizen_3 is a minor (age 11) ==");
  const challengeC = canisterMock.createChallenge("Gamma Casino");
  const minor = registry.citizens.find((c) => c.label.includes("MINOR"));
  await proveAndVerify({ citizen: minor, challenge: challengeC, expectAccept: false });
  console.log();

  console.log("== Summary ==");
  console.log("challenges:", Object.fromEntries(canisterMock.challenges));
  console.log("nullifiers consumed:", canisterMock.usedNullifiers.size);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
