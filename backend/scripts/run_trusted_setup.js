// run_trusted_setup.js
//
// Wraps the manual snarkjs CLI sequence used to produce build_v2/identity_proof_final.zkey
// and build_v2/verification_key.json. Local trusted setup only — fine for a PoC,
// NOT a substitute for a multi-party ceremony in production (see README limitations).
//
// Usage: node scripts/run_trusted_setup.js   (run AFTER npm run compile:circuit)

const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const BUILD_DIR = path.join(__dirname, "..", "build_v2");
const r1cs = path.join(BUILD_DIR, "identity_proof.r1cs");

function run(cmd) {
  console.log("$", cmd);
  execSync(cmd, { stdio: "inherit" });
}

function main() {
  if (!fs.existsSync(r1cs)) {
    console.error("Missing build_v2/identity_proof.r1cs — run `npm run compile:circuit` first.");
    process.exit(1);
  }

  const pot0 = path.join(BUILD_DIR, "pot13_0000.ptau");
  const pot1 = path.join(BUILD_DIR, "pot13_0001.ptau");
  const potFinal = path.join(BUILD_DIR, "pot13_final.ptau");
  const zkey0 = path.join(BUILD_DIR, "identity_proof_0000.zkey");
  const zkeyFinal = path.join(BUILD_DIR, "identity_proof_final.zkey");
  const vkey = path.join(BUILD_DIR, "verification_key.json");

  run(`npx snarkjs powersoftau new bn128 13 "${pot0}" -v`);
  run(`npx snarkjs powersoftau contribute "${pot0}" "${pot1}" --name="poc" -e="${Date.now()}-${Math.random()}"`);
  run(`npx snarkjs powersoftau prepare phase2 "${pot1}" "${potFinal}" -v`);
  run(`npx snarkjs groth16 setup "${r1cs}" "${potFinal}" "${zkey0}"`);
  run(`npx snarkjs zkey contribute "${zkey0}" "${zkeyFinal}" --name="poc" -e="${Date.now()}-${Math.random()}"`);
  run(`npx snarkjs zkey export verificationkey "${zkeyFinal}" "${vkey}"`);

  // Clean up the large intermediate ptau/zkey files — only the final zkey + vkey are needed downstream.
  for (const f of [pot0, pot1, potFinal, zkey0]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }

  console.log("\nDone. Final artifacts:");
  console.log(" ", zkeyFinal);
  console.log(" ", vkey);
}

main();
