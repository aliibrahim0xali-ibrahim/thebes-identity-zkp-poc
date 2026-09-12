pragma circom 2.0.0;

// PoC circuit (v2) — extends over18.circom with two things the single-commitment
// version didn't have:
//
//   1) MEMBERSHIP: instead of trusting one hardcoded commitment, the wallet now
//      proves its (birthYear, salt) leaf is included in a Merkle tree of ALL
//      enrolled citizens. The tree root is the one thing the issuer publishes
//      on the THEBES canister (see contracts/issuer_registry.mo -> identityRoot).
//
//   2) CHALLENGE BINDING: the proof is bound to a single-use `challenge` issued
//      by the verifying company (see the challenge/response flow discussed for
//      the THEBES identity front/back). The circuit outputs a `nullifier` =
//      Poseidon(salt, challenge). Two proofs from the SAME citizen for the SAME
//      challenge produce the SAME nullifier (so a canister can block replay by
//      rejecting a repeated nullifier), but nullifiers for two DIFFERENT
//      challenges from the same citizen are unlinkable to each other and to the
//      citizen's identity, because `salt` never leaves the wallet.
//
// Private inputs (wallet only): birthYear, salt, pathElements, pathIndices
// Public inputs (verifier sees): currentYear, merkleRoot, challenge
// Public output: nullifier

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/comparators.circom";
include "../node_modules/circomlib/circuits/mux1.circom";

template MerkleTreeInclusionProof(nLevels) {
    signal input leaf;
    signal input pathIndices[nLevels];
    signal input pathElements[nLevels];
    signal output root;

    signal levelHashes[nLevels + 1];
    levelHashes[0] <== leaf;

    component poseidons[nLevels];
    component mux[nLevels];

    for (var i = 0; i < nLevels; i++) {
        // pathIndices[i] must be 0 or 1 (0 = current node is the left child).
        pathIndices[i] * (1 - pathIndices[i]) === 0;

        mux[i] = MultiMux1(2);
        mux[i].c[0][0] <== levelHashes[i];
        mux[i].c[0][1] <== pathElements[i];
        mux[i].c[1][0] <== pathElements[i];
        mux[i].c[1][1] <== levelHashes[i];
        mux[i].s <== pathIndices[i];

        poseidons[i] = Poseidon(2);
        poseidons[i].inputs[0] <== mux[i].out[0];
        poseidons[i].inputs[1] <== mux[i].out[1];

        levelHashes[i + 1] <== poseidons[i].out;
    }

    root <== levelHashes[nLevels];
}

template IdentityOver18(nLevels) {
    signal input birthYear;
    signal input salt;
    signal input pathIndices[nLevels];
    signal input pathElements[nLevels];

    signal input currentYear;
    signal input merkleRoot;
    signal input challenge;

    signal output nullifier;

    // 1) leaf = Poseidon(birthYear, salt) — the same commitment the issuer
    //    anchored into the tree at enrollment time.
    component leafHasher = Poseidon(2);
    leafHasher.inputs[0] <== birthYear;
    leafHasher.inputs[1] <== salt;

    // 2) the leaf must sit under the published root.
    component merkle = MerkleTreeInclusionProof(nLevels);
    merkle.leaf <== leafHasher.out;
    for (var i = 0; i < nLevels; i++) {
        merkle.pathIndices[i] <== pathIndices[i];
        merkle.pathElements[i] <== pathElements[i];
    }
    merkle.root === merkleRoot;

    // 3) age predicate — unchanged from the v1 PoC.
    component ge = GreaterEqThan(16);
    ge.in[0] <== currentYear - birthYear;
    ge.in[1] <== 18;
    ge.out === 1;

    // 4) challenge-bound nullifier.
    component nullifierHasher = Poseidon(2);
    nullifierHasher.inputs[0] <== salt;
    nullifierHasher.inputs[1] <== challenge;
    nullifier <== nullifierHasher.out;
}

// nLevels = 3 -> a tree of up to 8 mock citizens, enough for this PoC.
component main {public [currentYear, merkleRoot, challenge]} = IdentityOver18(3);
