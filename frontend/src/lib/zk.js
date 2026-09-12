// zk.js — thin wrapper around snarkjs for the browser.
//
// Everything here runs entirely client-side: the wallet (citizen) generates a
// real Groth16 proof in the browser using the circuit's .wasm + the final
// .zkey (both public, non-secret artifacts — see backend/build_v2/). The
// verifying company checks it with the public verification_key.json, also
// entirely client-side. No private data (birthYear, salt) ever leaves this
// tab: only the proof + its public signals do.

import * as snarkjs from "snarkjs";

// IMPORTANT: these must NOT be hardcoded absolute paths ("/circuit/...").
// This app is served under a per-deployment subpath on THEBES
// (https://memphis.mercaturaforum.com/_/raw/<cid>/...), not the domain root.
// A leading "/" would make the browser fetch from the domain root and 404,
// exactly like the raw <script>/<link> tags did before vite.config.js set
// `base: "./"`. import.meta.env.BASE_URL is Vite's own resolved base
// ("./" in dev and in this build), so joining it here keeps these fetches
// correct under any subpath without hardcoding a cid.
const BASE = import.meta.env.BASE_URL; // e.g. "./"
const WASM_URL = `${BASE}circuit/identity_proof.wasm`;
const ZKEY_URL = `${BASE}circuit/identity_proof_final.zkey`;
const VKEY_URL = `${BASE}circuit/verification_key.json`;
const MOCK_REGISTRY_URL = `${BASE}circuit/mock_registry.json`;

let vkeyCache = null;
async function getVerificationKey() {
  if (!vkeyCache) {
    const res = await fetch(VKEY_URL);
    vkeyCache = await res.json();
  }
  return vkeyCache;
}

let registryCache = null;
export async function loadMockRegistry() {
  if (!registryCache) {
    const res = await fetch(MOCK_REGISTRY_URL);
    registryCache = await res.json();
  }
  return registryCache;
}

// challengeId is a hex string (as produced by the backend's createChallenge).
// The circuit's `challenge` public input is a field element, so we fold the
// hex id down to a BigInt the same way the original Node demo did.
export function challengeToField(challengeId) {
  // Take a stable numeric digest of the challenge id text so any length of
  // hex/id string maps into the BN254 scalar field.
  let acc = 0n;
  for (let i = 0; i < challengeId.length; i++) {
    acc = (acc * 131n + BigInt(challengeId.charCodeAt(i))) % FIELD_MODULUS;
  }
  return acc.toString();
}

const FIELD_MODULUS =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// citizen = { birthYear, salt, countryCode, idNumber, idExpiryDate,
//             pathIndices, pathElements } from mock_registry.json
// merkleRoot = the identityRoot published by the (mock) institution / canister
// currentYear, currentDate = public inputs the circuit checks age/ID-validity against
//
// idNumber and idExpiryDate never appear in the proof's public signals — they
// only feed the private leaf commitment inside the circuit. The proof only
// ever reveals: tree membership, age >= 18, countryCode == Egypt, and
// "idExpiryDate has not passed currentDate" — never the number or the date
// itself. See backend/circuits/identity_proof.circom for the constraints.
export async function generateProof({ citizen, merkleRoot, currentYear, currentDate, challengeId }) {
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
    merkleRoot,
    challenge: challengeToField(challengeId),
  };

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM_URL, ZKEY_URL);
  // publicSignals order (per the compiled circuit): [nullifier, currentYear, currentDate, merkleRoot, challenge]
  const [nullifier, outCurrentYear, outCurrentDate, outRoot, outChallenge] = publicSignals;
  return { proof, publicSignals, nullifier, outCurrentYear, outCurrentDate, outRoot, outChallenge };
}

export async function verifyProof(proof, publicSignals) {
  const vkey = await getVerificationKey();
  return snarkjs.groth16.verify(vkey, publicSignals, proof);
}
