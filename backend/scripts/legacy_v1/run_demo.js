// run_demo.js
//
// End-to-end local demo of the "prove age >= 18 without revealing birth year"
// flow described in the architecture. Everything runs locally: a real
// production deployment replaces the local powers-of-tau ceremony with a
// trusted multi-party ceremony, and replaces the "issuer" step with the
// actual signature THEBES anchors.
//
// Stages:
//   1) ISSUER (once, at enrollment)  -> computes commitment = Poseidon(birthYear, salt)
//   2) WALLET (every time a service needs proof) -> builds a Groth16 proof
//   3) VERIFIER (the government service) -> checks the proof, learns nothing else

const path = require("path");
const snarkjs = require("snarkjs");
const { buildPoseidon } = require("circomlibjs");
const fs = require("fs");

const BUILD_DIR = path.join(__dirname, "..", "build");

async function main() {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;

  // ---------- 1) ISSUER: one-time enrollment ----------
  const birthYear = 2000n;
  const salt = 123456789n; // random per-citizen secret, chosen at enrollment
  const commitmentField = poseidon([birthYear, salt]);
  const commitment = F.toObject(commitmentField); // what the issuer signs & THEBES anchors

  console.log("== 1) Issuer enrollment (once) ==");
  console.log("commitment published on-chain:", commitment.toString());
  console.log("(birthYear and salt stay in the wallet, never published)\n");

  // ---------- 2) WALLET: generate a ZK proof for a specific request ----------
  const currentYear = 2026n;
  const input = {
    birthYear: birthYear.toString(),
    salt: salt.toString(),
    currentYear: currentYear.toString(),
    commitment: commitment.toString(),
  };

  console.log("== 2) Wallet generates proof ==");
  console.log("public inputs sent to verifier:", { currentYear: input.currentYear, commitment: input.commitment });

  const wasmPath = path.join(BUILD_DIR, "over18_js", "over18.wasm");
  const zkeyPath = path.join(BUILD_DIR, "over18_final.zkey");
  const vkeyPath = path.join(BUILD_DIR, "verification_key.json");

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasmPath, zkeyPath);
  console.log("proof generated. size (bytes):", JSON.stringify(proof).length, "\n");

  // ---------- 3) VERIFIER: the government service checks the proof ----------
  console.log("== 3) Government service verifies ==");
  const vkey = JSON.parse(fs.readFileSync(vkeyPath));
  const ok = await snarkjs.groth16.verify(vkey, publicSignals, proof);
  console.log("verification result:", ok ? "ACCEPTED — citizen is 18+, credential valid" : "REJECTED");

  // ---------- Negative control: someone under 18 tries the same flow ----------
  console.log("\n== Negative control: birthYear = 2015 (age 11) ==");
  const youngBirthYear = 2015n;
  const youngSalt = 987654321n;
  const youngCommitment = F.toObject(poseidon([youngBirthYear, youngSalt]));
  try {
    await snarkjs.groth16.fullProve(
      {
        birthYear: youngBirthYear.toString(),
        salt: youngSalt.toString(),
        currentYear: currentYear.toString(),
        commitment: youngCommitment.toString(),
      },
      wasmPath,
      zkeyPath,
    );
    console.log("UNEXPECTED: proof should not have been constructible");
  } catch (e) {
    console.log("As expected: the circuit refuses to produce a proof (age constraint unsatisfied).");
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
