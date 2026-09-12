// build_mock_registry.js
//
// Stands in for the step "an institution verifies uploaded ID+selfie data and
// registers the result on the THEBES canister" — which is not wired up yet.
// Until that integration exists, this script plays the institution's role
// with MOCK data: it invents N citizens, computes each one's commitment
// exactly the way the real issuer would (Poseidon(birthYear, salt)), and
// builds the same Poseidon Merkle tree the circuit verifies membership
// against. The root this script prints is what would be handed to
// issuer_registry.mo's registerIdentityRoot(...) in a real deployment.
//
// Swap this file out (not the circuit, not the contract) once real
// enrollment data is coming from an actual upload+verification flow.

const fs = require("fs");
const path = require("path");
const { buildPoseidon } = require("circomlibjs");

const N_LEVELS = 3; // must match `component main = IdentityOver18(3)` in the circuit
const N_LEAVES = 2 ** N_LEVELS;

const OUT_PATH = path.join(__dirname, "..", "build_v2", "mock_registry.json");

// Deterministic mock citizens so re-running this script reproduces the same
// tree/root every time (useful for repeatable demos). Two are intentionally
// under 18, to exercise the negative-control path in run_demo.js.
const MOCK_CITIZENS = [
  { label: "citizen_0 (adult, 26)", birthYear: 2000n, salt: 1111111111n },
  { label: "citizen_1 (adult, 40)", birthYear: 1986n, salt: 2222222222n },
  { label: "citizen_2 (adult, 19)", birthYear: 2007n, salt: 3333333333n },
  { label: "citizen_3 (MINOR, 11)", birthYear: 2015n, salt: 4444444444n },
  { label: "citizen_4 (adult, 55)", birthYear: 1971n, salt: 5555555555n },
  { label: "citizen_5 (adult, 22)", birthYear: 2004n, salt: 6666666666n },
  { label: "citizen_6 (MINOR, 15)", birthYear: 2011n, salt: 7777777777n },
  { label: "citizen_7 (adult, 33)", birthYear: 1993n, salt: 8888888888n },
];

async function main() {
  if (MOCK_CITIZENS.length > N_LEAVES) {
    throw new Error(`circuit only supports ${N_LEAVES} leaves at depth ${N_LEVELS}`);
  }

  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  const hash2 = (a, b) => F.toObject(poseidon([a, b]));

  // Pad to a full 2^N_LEVELS tree with a fixed zero-leaf, exactly like the
  // circuit does implicitly (no special-casing for a partial tree).
  const ZERO_LEAF = 0n;
  const leaves = [];
  for (let i = 0; i < N_LEAVES; i++) {
    if (i < MOCK_CITIZENS.length) {
      const c = MOCK_CITIZENS[i];
      leaves.push(hash2(c.birthYear, c.salt));
    } else {
      leaves.push(ZERO_LEAF);
    }
  }

  // Build the tree level by level, recording every node so we can hand back
  // a (pathElements, pathIndices) sibling path for any leaf index.
  const levels = [leaves];
  for (let lvl = 0; lvl < N_LEVELS; lvl++) {
    const cur = levels[lvl];
    const next = [];
    for (let i = 0; i < cur.length; i += 2) {
      next.push(hash2(cur[i], cur[i + 1]));
    }
    levels.push(next);
  }
  const root = levels[N_LEVELS][0];

  function pathFor(index) {
    const pathElements = [];
    const pathIndices = [];
    let idx = index;
    for (let lvl = 0; lvl < N_LEVELS; lvl++) {
      const isRight = idx % 2 === 1;
      const siblingIdx = isRight ? idx - 1 : idx + 1;
      pathElements.push(levels[lvl][siblingIdx].toString());
      pathIndices.push(isRight ? 1 : 0); // 0 = I am the left child
      idx = Math.floor(idx / 2);
    }
    return { pathElements, pathIndices };
  }

  const registry = {
    generatedAt: new Date().toISOString(),
    nLevels: N_LEVELS,
    root: root.toString(),
    citizens: MOCK_CITIZENS.map((c, i) => {
      const { pathElements, pathIndices } = pathFor(i);
      return {
        index: i,
        label: c.label,
        birthYear: c.birthYear.toString(),
        salt: c.salt.toString(),
        leaf: leaves[i].toString(),
        pathElements,
        pathIndices,
      };
    }),
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(registry, null, 2));

  console.log("== Mock institution: enrolling", MOCK_CITIZENS.length, "citizens ==");
  for (const c of registry.citizens) console.log(`  leaf[${c.index}] = ${c.label}`);
  console.log("\nidentityRoot (this is what gets registered on the THEBES canister):");
  console.log(" ", registry.root);
  console.log("\nwritten to", OUT_PATH);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
