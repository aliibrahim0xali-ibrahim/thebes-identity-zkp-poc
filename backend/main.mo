// issuer_registry.mo
//
// Anchoring layer for the PoC — deployed on THEBES (testnet).
// This canister stores NO personal data whatsoever and never runs the
// SNARK verifier itself (Groth16 pairing checks on-chain are future work —
// see the honesty note at the bottom of README.md). What it DOES anchor:
//
//   1) identityRoot — the Merkle root over all enrolled citizens' commitments
//      (Poseidon(birthYear, salt)). Published by a trusted institution after
//      it verifies uploaded ID+selfie data off-chain. Until that integration
//      exists, `registerIdentityRoot` is called with a MOCK root produced by
//      scripts/build_mock_registry.js.
//
//   2) challenges — single-use, expiring challenge codes a company requests
//      before asking a citizen for proof. A proof is only meaningful if it
//      was built for a specific, still-pending challenge.
//
//   3) usedNullifiers — every nullifier a proof has ever spent. This is the
//      replay guard: the SAME (citizen, challenge) pair can only ever
//      succeed once, without the canister ever learning which citizen it was.
//
// The actual cryptographic Groth16 check happens off-chain, at the verifying
// company, using the public verification_key.json from this PoC's build/.
// The company calls consumeNullifier(...) ONLY after it has locally verified
// the proof and confirmed publicSignals.merkleRoot == getIdentityRoot() and
// publicSignals.challenge == the challenge it issued. The canister is the
// single source of truth for "has this proof already been spent" — a company
// cannot be tricked by a forwarded/replayed proof even if it forgets to
// check locally, because a second consumeNullifier call for the same
// nullifier always fails.

import Array "mo:base/Array";
import Principal "mo:base/Principal";
import Blob "mo:base/Blob";
import Text "mo:base/Text";
import Time "mo:base/Time";
import Int "mo:base/Int";
import HashMap "mo:base/HashMap";
import Iter "mo:base/Iter";

persistent actor IssuerRegistry {

  public type IssuerId = Text;
  public type ChallengeId = Text;
  public type ChallengeStatus = { #Pending; #Verified; #Expired };

  public type IssuerRecord = {
    id : IssuerId;
    publicKey : Blob;      // Ed25519 / threshold public key of the issuer
    registeredAt : Int;
    active : Bool;
  };

  public type Challenge = {
    companyName : Text;
    createdAt : Int;
    expiresAt : Int;
    status : ChallengeStatus;
  };

  transient let CHALLENGE_TTL_NS : Int = 10 * 60 * 1_000_000_000; // 10 minutes

  // --- state (persisted across upgrades by default, since this is a `persistent actor`) ---
  var issuers : [IssuerRecord] = [];
  var admin : Principal = Principal.fromText("aaaaa-aa"); // replace at deploy time

  // The Merkle root over enrolled citizens' commitments. `null` until the
  // institution (or, for now, the mock script) registers one.
  var identityRoot : ?Blob = null;
  var identityRootUpdatedAt : Int = 0;

  var challengeEntries : [(ChallengeId, Challenge)] = [];
  transient var challenges = HashMap.HashMap<ChallengeId, Challenge>(0, Text.equal, Text.hash);

  var usedNullifierEntries : [(Blob, Bool)] = [];
  transient var usedNullifiers = HashMap.HashMap<Blob, Bool>(0, Blob.equal, Blob.hash);

  system func preupgrade() {
    challengeEntries := Iter.toArray(challenges.entries());
    usedNullifierEntries := Iter.toArray(usedNullifiers.entries());
  };

  system func postupgrade() {
    challenges := HashMap.fromIter<ChallengeId, Challenge>(challengeEntries.vals(), challengeEntries.size(), Text.equal, Text.hash);
    usedNullifiers := HashMap.fromIter<Blob, Bool>(usedNullifierEntries.vals(), usedNullifierEntries.size(), Blob.equal, Blob.hash);
  };

  // --- issuer key registry (unchanged from v1) ---

  public shared (msg) func registerIssuer(id : IssuerId, publicKey : Blob) : async Bool {
    if (msg.caller != admin) { return false };
    let exists = Array.find<IssuerRecord>(issuers, func(r) { r.id == id });
    switch (exists) {
      case (?_) { false };
      case null {
        issuers := Array.append(issuers, [{ id; publicKey; registeredAt = Time.now(); active = true }]);
        true;
      };
    };
  };

  public shared (msg) func setIssuerActive(id : IssuerId, active : Bool) : async Bool {
    if (msg.caller != admin) { return false };
    issuers := Array.map<IssuerRecord, IssuerRecord>(issuers, func(r) { if (r.id == id) { { r with active } } else { r } });
    true;
  };

  public query func getIssuerKey(id : IssuerId) : async ?Blob {
    switch (Array.find<IssuerRecord>(issuers, func(r) { r.id == id and r.active })) {
      case (?r) { ?r.publicKey };
      case null { null };
    };
  };

  public query func listIssuers() : async [IssuerRecord] { issuers };

  // --- identity Merkle root ---
  //
  // Admin-only for now (the mock script's controller). Once a real
  // institution integration exists, this becomes issuer-signature-gated
  // instead of a single admin principal.

  public shared (msg) func registerIdentityRoot(newRoot : Blob) : async Bool {
    if (msg.caller != admin) { return false };
    identityRoot := ?newRoot;
    identityRootUpdatedAt := Time.now();
    true;
  };

  public query func getIdentityRoot() : async ?Blob { identityRoot };

  public query func getIdentityRootUpdatedAt() : async Int { identityRootUpdatedAt };

  // --- challenge lifecycle ---
  //
  // A company calls createChallenge before asking a citizen for proof. The
  // wallet's proof is only accepted if it targets a still-Pending, not
  // expired challenge (checked in consumeNullifier below).

  public shared func createChallenge(companyName : Text) : async ChallengeId {
    // NOTE: a production deployment should derive `id` from THEBES's chain
    // randomness (raw_rand on the management canister), the same primitive
    // Proofly uses, rather than from caller-supplied entropy.
    let now = Time.now();
    let id = Int.toText(now) # "-" # companyName;
    challenges.put(id, { companyName; createdAt = now; expiresAt = now + CHALLENGE_TTL_NS; status = #Pending });
    id;
  };

  public query func getChallenge(id : ChallengeId) : async ?Challenge {
    challenges.get(id);
  };

  public query func isNullifierUsed(nullifier : Blob) : async Bool {
    switch (usedNullifiers.get(nullifier)) {
      case (?_) { true };
      case null { false };
    };
  };

  public type ConsumeResult = { #Ok; #UnknownChallenge; #ChallengeNotPending; #ChallengeExpired; #NullifierAlreadyUsed };

  // Called by the VERIFYING COMPANY after it has locally checked the Groth16
  // proof against verification_key.json and confirmed the proof's public
  // `merkleRoot` equals getIdentityRoot() and its `challenge` equals `id`.
  // This call is what actually prevents replay: it can only ever succeed
  // once per (challenge, nullifier) pair.
  public shared func consumeNullifier(id : ChallengeId, nullifier : Blob) : async ConsumeResult {
    switch (challenges.get(id)) {
      case null { #UnknownChallenge };
      case (?ch) {
        if (ch.status != #Pending) { return #ChallengeNotPending };
        if (Time.now() > ch.expiresAt) {
          challenges.put(id, { ch with status = #Expired });
          return #ChallengeExpired;
        };
        switch (usedNullifiers.get(nullifier)) {
          case (?_) { #NullifierAlreadyUsed };
          case null {
            usedNullifiers.put(nullifier, true);
            challenges.put(id, { ch with status = #Verified });
            #Ok;
          };
        };
      };
    };
  };
};
