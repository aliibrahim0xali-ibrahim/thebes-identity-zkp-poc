// backendClient.js
//
// This module is the ONLY place the frontend talks to "the canister". Right
// now it is a DEV MOCK: an in-memory object that reproduces, method-for-
// method, the exact state machine implemented in backend/main.mo
// (identityRoot, challenges Pending/Verified/Expired, usedNullifiers).
//
// Why a mock at all: this sandbox has no `moc`/`thebes-deploy` available, so
// the Motoko canister can't be compiled+installed here. The mock lets the
// full citizen -> company -> verify -> replay-rejected flow be exercised and
// tested end-to-end in the browser today.
//
// SWAPPING TO THE REAL CANISTER: once `backend/main.mo` is deployed with
// `thebes-deploy deploy backend`, replace the body of each exported function
// below with a call through `@thebes/sdk`'s actor client, e.g.:
//
//   import { createActor } from "@thebes/sdk";
//   const actor = createActor(BACKEND_CID, { idlFactory });
//   export const createChallenge = (companyName) => actor.createChallenge(companyName);
//
// The function names and shapes here were chosen to match main.mo's public
// interface 1:1, so that swap is mechanical and doesn't touch any UI code.

const CHALLENGE_TTL_MS = 10 * 60 * 1000; // 10 minutes, mirrors CHALLENGE_TTL_NS in main.mo

function randomChallengeId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

class MockCanister {
  constructor() {
    this.identityRoot = null;
    this.identityRootUpdatedAt = null;
    this.challenges = new Map(); // id -> { companyName, createdAt, expiresAt, status }
    this.usedNullifiers = new Set();
  }

  async registerIdentityRoot(root) {
    this.identityRoot = root;
    this.identityRootUpdatedAt = Date.now();
    return true;
  }

  async getIdentityRoot() {
    return this.identityRoot;
  }

  async createChallenge(companyName) {
    const id = randomChallengeId();
    const now = Date.now();
    this.challenges.set(id, {
      companyName,
      createdAt: now,
      expiresAt: now + CHALLENGE_TTL_MS,
      status: "Pending",
    });
    return id;
  }

  async getChallenge(id) {
    return this.challenges.get(id) ?? null;
  }

  async isNullifierUsed(nullifier) {
    return this.usedNullifiers.has(nullifier);
  }

  // Mirrors main.mo's ConsumeResult variant exactly.
  async consumeNullifier(challengeId, nullifier) {
    const ch = this.challenges.get(challengeId);
    if (!ch) return { ok: false, reason: "UnknownChallenge" };
    if (ch.status !== "Pending") return { ok: false, reason: "ChallengeNotPending", status: ch.status };
    if (Date.now() > ch.expiresAt) {
      ch.status = "Expired";
      return { ok: false, reason: "ChallengeExpired" };
    }
    if (this.usedNullifiers.has(nullifier)) {
      return { ok: false, reason: "NullifierAlreadyUsed" };
    }
    this.usedNullifiers.add(nullifier);
    ch.status = "Verified";
    return { ok: true };
  }
}

// Singleton for the lifetime of the tab — good enough for a local PoC demo.
// (A real deploy has no such singleton: state lives on the THEBES canister.)
const canister = new MockCanister();

// --- real-time state notifications --------------------------------------
// The Status page needs to reflect this canister's actual state the moment
// it changes (not just on a polling interval). Since this mock lives
// in-process, we can push updates synchronously right after every call that
// mutates state — that's the most "real-time" a same-tab mock can honestly
// be. (A real THEBES canister has no push channel; a live deployment would
// still need to poll or use a query subscription, which is a separate,
// larger change from this PoC's scope.)
const listeners = new Set();

function snapshot() {
  return {
    identityRoot: canister.identityRoot,
    identityRootUpdatedAt: canister.identityRootUpdatedAt,
    challenges: Object.fromEntries(canister.challenges),
    nullifiersConsumed: canister.usedNullifiers.size,
  };
}

function notify() {
  const state = snapshot();
  for (const fn of listeners) fn(state);
}

function subscribe(fn) {
  listeners.add(fn);
  fn(snapshot()); // immediate first value, no waiting for the next change
  return () => listeners.delete(fn);
}

export const backend = {
  registerIdentityRoot: async (root) => {
    const res = await canister.registerIdentityRoot(root);
    notify();
    return res;
  },
  getIdentityRoot: () => canister.getIdentityRoot(),
  createChallenge: async (companyName) => {
    const id = await canister.createChallenge(companyName);
    notify();
    return id;
  },
  getChallenge: (id) => canister.getChallenge(id),
  isNullifierUsed: (n) => canister.isNullifierUsed(n),
  consumeNullifier: async (id, n) => {
    const res = await canister.consumeNullifier(id, n);
    notify(); // challenge status + nullifier count both change here
    return res;
  },
  // exposed for the "institution" admin screen / debug panel only
  _debugState: () => snapshot(),
  // Status page subscribes here instead of polling, so it reflects this
  // mock canister's real state the instant it changes.
  _subscribe: subscribe,
};
