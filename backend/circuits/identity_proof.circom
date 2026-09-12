pragma circom 2.0.0;

// PoC circuit (v3) — extends the v2 age/membership circuit with two more
// private attributes, per the same "prove a predicate, reveal nothing else"
// pattern as the age check:
//
//   3) CITIZENSHIP: the enrolled record carries a countryCode. The circuit
//      constrains it to equal EGYPT_COUNTRY_CODE (818, the ISO 3166-1
//      numeric code) — so a valid proof means "this leaf's committed
//      countryCode is Egypt's", without ever putting countryCode itself in
//      the public signals. (In this single-tree demo every leaf is already
//      Egyptian by construction — this constraint documents and enforces
//      that formally in-circuit, rather than leaving it as an unstated
//      assumption about which tree you happened to be looking at.)
//
//   4) ID VALIDITY: the enrolled record also carries idNumber (the citizen's
//      digital ID card number) and idExpiryDate (YYYYMMDD, e.g. 20301231).
//      The circuit constrains idExpiryDate >= the public currentDate — i.e.
//      "this person's ID card has not expired as of today" — WITHOUT ever
//      revealing idNumber or idExpiryDate. idNumber only ever appears baked
//      into the leaf commitment; it is never a circuit output or a public
//      signal, exactly like birthYear/salt.
//
// Private inputs (wallet only): birthYear, salt, countryCode, idNumber,
//                                idExpiryDate, pathElements, pathIndices
// Public inputs (verifier sees): currentYear, currentDate, merkleRoot, challenge
// Public output: nullifier
//
// Honest limitation (documented, not hidden): like the existing age check
// (which trusts the wallet's `currentYear` rather than an oracle), the
// "not expired" check trusts the wallet's `currentDate` input rather than
// pulling real-world time from anywhere on-chain. A company verifying the
// proof today has no in-circuit guarantee `currentDate` really is today —
// it can only sanity-check it isn't wildly wrong when it reads the public
// signal. Making `currentDate` itself trustworthy would need a time oracle,
// which is out of scope for this PoC.

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

template IdentityCredential(nLevels) {
    signal input birthYear;
    signal input salt;
    signal input countryCode;
    signal input idNumber;
    signal input idExpiryDate; // YYYYMMDD, e.g. 20301231
    signal input pathIndices[nLevels];
    signal input pathElements[nLevels];

    signal input currentYear;
    signal input currentDate; // YYYYMMDD, e.g. 20260912
    signal input merkleRoot;
    signal input challenge;

    signal output nullifier;

    // 1) leaf = Poseidon(birthYear, salt, countryCode, idNumber, idExpiryDate)
    //    — the same commitment the issuer anchored into the tree at
    //    enrollment time. idNumber and idExpiryDate are baked in here and
    //    NEVER appear anywhere else in this circuit, so they never reach a
    //    public signal.
    component leafHasher = Poseidon(5);
    leafHasher.inputs[0] <== birthYear;
    leafHasher.inputs[1] <== salt;
    leafHasher.inputs[2] <== countryCode;
    leafHasher.inputs[3] <== idNumber;
    leafHasher.inputs[4] <== idExpiryDate;

    // 2) the leaf must sit under the published root.
    component merkle = MerkleTreeInclusionProof(nLevels);
    merkle.leaf <== leafHasher.out;
    for (var i = 0; i < nLevels; i++) {
        merkle.pathIndices[i] <== pathIndices[i];
        merkle.pathElements[i] <== pathElements[i];
    }
    merkle.root === merkleRoot;

    // 3) age predicate — unchanged from v2.
    component ge = GreaterEqThan(16);
    ge.in[0] <== currentYear - birthYear;
    ge.in[1] <== 18;
    ge.out === 1;

    // 4) citizenship predicate — countryCode must equal Egypt's ISO 3166-1
    //    numeric code (818). countryCode itself is never output.
    var EGYPT_COUNTRY_CODE = 818;
    countryCode === EGYPT_COUNTRY_CODE;

    // 5) ID-validity predicate — idExpiryDate must not be before today.
    //    32 bits comfortably covers any YYYYMMDD value (max ~99999999).
    component idNotExpired = GreaterEqThan(32);
    idNotExpired.in[0] <== idExpiryDate;
    idNotExpired.in[1] <== currentDate;
    idNotExpired.out === 1;

    // 6) challenge-bound nullifier — unchanged from v2.
    component nullifierHasher = Poseidon(2);
    nullifierHasher.inputs[0] <== salt;
    nullifierHasher.inputs[1] <== challenge;
    nullifier <== nullifierHasher.out;
}

// nLevels = 3 -> a tree of up to 8 mock citizens, enough for this PoC.
component main {public [currentYear, currentDate, merkleRoot, challenge]} = IdentityCredential(3);
