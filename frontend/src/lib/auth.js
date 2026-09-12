// auth.js — passkey sign-in for the Citizen tab.
//
// This mirrors the login *concept* used by mercature-notes (a Memphis
// passkey gate: `MemphisAuth.initFromCid(921, "mercature-notes", 1)`) —
// a real WebAuthn ceremony that opens a session, rather than the old
// "pick a name from a dropdown" placeholder.
//
// IMPORTANT — what this deliberately does NOT do:
// Signing in only proves that the SAME browser/device that holds a
// passkey is present again. It is not, and must never be treated as,
// evidence that any institution checked this person's documents. This
// project's whole point is that identity-tree membership only comes
// from a real issuer's Poseidon(birthYear, salt) commitment being built
// into the published Merkle tree (see backend/scripts/build_mock_registry.js).
// So on sign-in we do NOT fabricate a new "verified" citizen out of thin
// air. We deterministically link the passkey credential to one of the
// EXISTING, already-disclosed demo citizens in mock_registry.json (adults
// only — never a minor row), the same fixture the old dropdown exposed.
// That keeps this demo self-consistent: proofs still only verify against
// this same app's own mock canister/root, exactly as before. It is not,
// and cannot be turned into, a way to make a real outside company treat
// an unverified person as authority-checked.
//
// Like the real Memphis flow, WebAuthn is pinned to the serving origin,
// so it will not work from `npm run dev` on localhost — only once this
// is deployed (see README "Deploying to THEBES"). A dev-mode fallback is
// provided below so the demo still runs locally, and it is labeled as
// such in the UI — it is never silently substituted after a real deploy.

function bufToHex(buf) {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

function textToBuf(text) {
  return new TextEncoder().encode(text);
}

export function passkeysSupported() {
  return typeof window !== "undefined" &&
    !!window.PublicKeyCredential &&
    !!navigator.credentials;
}

// A stable per-site id for the WebAuthn ceremony. In the real Memphis flow
// this is scoped by the deployed cid (see mercature-notes' initFromCid);
// here we just scope it to the current origin/hostname.
function relyingPartyId() {
  return window.location.hostname;
}

const CREDENTIAL_STORAGE_KEY = "thebes_poc_passkey_credential_id";

// Registers a brand-new passkey for this browser (first-time sign-in), or
// re-authenticates with one already registered here. Returns a stable
// credentialId (hex) that identifies "this session" going forward — the
// same role `session` plays in mercature-notes' shared/tip calls.
export async function passkeySignIn() {
  if (!passkeysSupported()) {
    throw new Error("PASSKEYS_UNSUPPORTED");
  }

  const existingId = window.sessionStorage.getItem(CREDENTIAL_STORAGE_KEY);

  if (existingId) {
    // Re-authenticate with the credential this tab already created.
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: [{ id: hexToBuf(existingId), type: "public-key" }],
        rpId: relyingPartyId(),
        userVerification: "preferred",
        timeout: 60000,
      },
    });
    if (!assertion) throw new Error("PASSKEY_CANCELLED");
    return existingId;
  }

  // First time in this tab: create a new passkey.
  const credential = await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: "THEBES Identity PoC", id: relyingPartyId() },
      user: {
        id: crypto.getRandomValues(new Uint8Array(16)),
        name: "citizen@thebes-poc.local",
        displayName: "THEBES PoC citizen",
      },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },   // ES256
        { type: "public-key", alg: -257 }, // RS256
      ],
      authenticatorSelection: { userVerification: "preferred" },
      timeout: 60000,
      attestation: "none",
    },
  });
  if (!credential) throw new Error("PASSKEY_CANCELLED");

  const credentialId = bufToHex(credential.rawId);
  window.sessionStorage.setItem(CREDENTIAL_STORAGE_KEY, credentialId);
  return credentialId;
}

function hexToBuf(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes.buffer;
}

// Dev-mode fallback: on localhost, or in any browser without passkey
// support, WebAuthn's origin pinning makes the real ceremony impossible
// (documented limitation, same as the real Memphis flow — see README).
// This mints a random per-tab id instead of a real credential, so the demo
// still runs locally. It is surfaced in the UI as "(dev mode)" so it is
// never confused with a real sign-in.
export function devModeSignIn() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bufToHex(bytes.buffer);
}

// Deterministically links a signed-in session to one of the EXISTING
// pre-verified demo citizens in mock_registry.json — adults only, a minor
// row is never selected. This is a stand-in for "the institution already
// verified this person and put them in the tree"; it does not add a new
// leaf or touch the published root in any way.
export async function citizenIndexForSession(credentialId, registry) {
  const adultIndices = registry.citizens
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => /minor/i.test(c.label) === false)
    .map(({ i }) => i);

  if (adultIndices.length === 0) return 0; // shouldn't happen with this registry

  const digest = await crypto.subtle.digest("SHA-256", textToBuf(credentialId));
  const asUint = new DataView(digest).getUint32(0);
  return adultIndices[asUint % adultIndices.length];
}
