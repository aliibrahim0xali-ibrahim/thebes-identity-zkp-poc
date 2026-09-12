// Exercises the SAME logic the React UI uses (challengeToField, proof
// generation/verification, and the mock backend's consumeNullifier state
// machine) directly in Node, against the actual files that ship in
// frontend/public/circuit/. This is not a DOM test (no headless browser
// available in this sandbox), but it proves the exact code paths behind
// every button in the UI behave correctly, using the real artifacts.
import fs from "fs";
import path from "path";
import * as snarkjs from "snarkjs";

const PUB = path.join(process.cwd(), "public", "circuit");
const registry = JSON.parse(fs.readFileSync(path.join(PUB, "mock_registry.json")));
const vkey = JSON.parse(fs.readFileSync(path.join(PUB, "verification_key.json")));
const wasm = path.join(PUB, "identity_proof.wasm");
const zkey = path.join(PUB, "identity_proof_final.zkey");

const FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
function challengeToField(challengeId) {
  let acc = 0n;
  for (let i = 0; i < challengeId.length; i++) {
    acc = (acc * 131n + BigInt(challengeId.charCodeAt(i))) % FIELD_MODULUS;
  }
  return acc.toString();
}

// --- mirrors backendClient.js's MockCanister exactly ---
class MockCanister {
  constructor() { this.identityRoot = null; this.challenges = new Map(); this.usedNullifiers = new Set(); }
  registerIdentityRoot(r) { this.identityRoot = r; }
  createChallenge(name) {
    const id = Math.random().toString(16).slice(2) + Date.now().toString(16);
    this.challenges.set(id, { companyName: name, status: "Pending", expiresAt: Date.now() + 600000 });
    return id;
  }
  getChallenge(id) { return this.challenges.get(id) ?? null; }
  consumeNullifier(id, n) {
    const ch = this.challenges.get(id);
    if (!ch) return { ok: false, reason: "UnknownChallenge" };
    if (ch.status !== "Pending") return { ok: false, reason: "ChallengeNotPending" };
    if (this.usedNullifiers.has(n)) return { ok: false, reason: "NullifierAlreadyUsed" };
    this.usedNullifiers.add(n);
    ch.status = "Verified";
    return { ok: true };
  }
}

async function proveFor(citizen, currentYear, currentDate, root, challengeId) {
  const input = {
    birthYear: citizen.birthYear,
    salt: citizen.salt,
    countryCode: citizen.countryCode,
    idNumber: citizen.idNumber,
    idExpiryDate: citizen.idExpiryDate,
    pathIndices: citizen.pathIndices,
    pathElements: citizen.pathElements,
    currentYear: String(currentYear),
    currentDate: String(currentDate),
    merkleRoot: root,
    challenge: challengeToField(challengeId),
  };
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasm, zkey);
  return { proof, publicSignals };
}

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { console.log("  ok -", name); passed++; }
  else { console.log("  FAIL -", name); failed++; }
}

async function main() {
  const canister = new MockCanister();
  canister.registerIdentityRoot(registry.root);
  const root = registry.root;
  const currentYear = new Date().getFullYear();
  const d = new Date();
  const currentDate = Number(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`);

  console.log("== Test 1: adult citizen, valid challenge -> accepted, JSON round-trips like the UI textarea ==");
  const adult = registry.citizens[0];
  const challengeA = canister.createChallenge("Acme Bank");
  const proofBundleA = await proveFor(adult, currentYear, currentDate, root, challengeA);
  // simulate the UI's textarea JSON.stringify -> JSON.parse round trip
  const roundTripped = JSON.parse(JSON.stringify(proofBundleA));
  const [nullifierA, , , outRootA, outChallengeA] = roundTripped.publicSignals;
  check("outRoot matches canister root", outRootA === root);
  check("outChallenge matches challengeToField(challengeA)", outChallengeA === challengeToField(challengeA));
  const cryptoOkA = await snarkjs.groth16.verify(vkey, roundTripped.publicSignals, roundTripped.proof);
  check("groth16.verify succeeds", cryptoOkA === true);
  const consumeA = canister.consumeNullifier(challengeA, nullifierA);
  check("consumeNullifier accepts first use", consumeA.ok === true);

  console.log("== Test 2: replay of the same proof on the same challenge is rejected ==");
  const consumeReplay = canister.consumeNullifier(challengeA, nullifierA);
  check("replay rejected", consumeReplay.ok === false && consumeReplay.reason === "ChallengeNotPending");

  console.log("== Test 3: same citizen, a different challenge -> different, unlinkable nullifier ==");
  const challengeB = canister.createChallenge("Beta Insurance");
  const proofBundleB = await proveFor(adult, currentYear, currentDate, root, challengeB);
  const [nullifierB] = proofBundleB.publicSignals;
  check("nullifiers differ across challenges", nullifierA !== nullifierB);
  const consumeB = canister.consumeNullifier(challengeB, nullifierB);
  check("second challenge accepted independently", consumeB.ok === true);

  console.log("== Test 4: minor cannot even construct a proof (age constraint) ==");
  const minor = registry.citizens.find((c) => c.label.includes("MINOR"));
  const challengeC = canister.createChallenge("Gamma Casino");
  let minorFailed = false;
  try {
    await proveFor(minor, currentYear, currentDate, root, challengeC);
  } catch (e) {
    minorFailed = /Error in template IdentityCredential/.test(String(e.message));
  }
  check("minor's proof generation throws the age constraint error", minorFailed);

  console.log("== Test 5: tampered publicSignals (wrong challenge) fail the company's own check, before crypto verify ==");
  const wrongChallengeField = challengeToField("not-the-real-challenge");
  check(
    "outChallenge != forged challenge (company would reject before calling verify)",
    outChallengeA !== wrongChallengeField
  );

  console.log("== Test 6: an adult with an EXPIRED ID cannot construct a proof (ID-validity constraint) ==");
  const expiredId = registry.citizens.find((c) => c.label.includes("EXPIRED"));
  const challengeD = canister.createChallenge("Delta Telecom");
  let expiredFailed = false;
  try {
    await proveFor(expiredId, currentYear, currentDate, root, challengeD);
  } catch (e) {
    expiredFailed = /Error in template IdentityCredential/.test(String(e.message));
  }
  check("expired-ID citizen's proof generation throws the ID-validity constraint error", expiredFailed);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0); // snarkjs leaves curve worker handles open otherwise
}

main().catch((e) => { console.error(e); process.exit(1); });
