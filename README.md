# Zero-Knowledge Identity Proof — THEBES PoC

A complete project (**frontend + backend**, ready to deploy with
`thebes-deploy`) that actually implements the loop: a citizen proves "I am
registered in the identity tree **and** I am 18 or older" to any company
that asks, bound to that company's Challenge, **without** sending their date
of birth or even revealing which registered citizen they are — using a real
zk-SNARK (Groth16) proof generated **inside the citizen's own browser**.

## Structure (frontend + backend only, as requested)

```
thebes_identity_poc/
├── thebes.toml              ← deploy manifest for THEBES (backend canister + frontend canister)
├── mops.toml                ← Motoko package deps (base) — required so `moc` can resolve mo:base/*
├── backend/                 ← everything that is built/deployed as the "backend"
│   ├── main.mo               THEBES canister source (identityRoot / challenges / nullifiers)
│   ├── circuits/              the circom circuit that the proof artifacts are compiled from
│   ├── build_v2/               build outputs: r1cs, wasm, zkey, verification_key.json — the same
│   │                           files the frontend consumes
│   ├── scripts/                mock-institution tooling (builds a Merkle tree) + a Node reference
│   │                           script that exercises the full flow outside the browser
│   └── legacy_v1_issuer_registry.mo.bak   v1 snapshot (single commitment, no tree) — kept for reference only
└── frontend/                 ← React + Vite app (English/LTR) — the end user's "front door"
    ├── public/circuit/        a copy of the build_v2 outputs (wasm/zkey/vkey/mock_registry) so the
    │                           browser can load them
    └── src/
        ├── App.jsx             header + tabs
        ├── pages/CitizenPage.jsx    citizen flow (pick a mock identity → generate a proof)
        ├── pages/CompanyPage.jsx    company flow (create a Challenge → public verification page)
        ├── pages/StatusPage.jsx     debug panel showing canister state during a demo
        ├── lib/zk.js               the snarkjs wrapper (proof generation/verification, all in-browser)
        └── lib/backendClient.js    the "backend client" — currently an in-browser mock, swaps to real
                                     canister calls after deployment
```

## What's real today vs. what's still mocked

| Part | Status |
|---|---|
| The circuit (circom) + the proof (Groth16 via snarkjs) | **100% real** — generated and verified live in the browser, no simulation |
| The 8-citizen Merkle tree | Real (Poseidon hashing), but the citizens' underlying data is mocked (no real institution integration yet that ingests an ID photo + selfie) |
| The `backend/main.mo` canister (identityRoot / Challenge / nullifier) | The source is real and deploy-ready, but it was **not actually compiled with `moc`** in the original sandbox — it needs a `mops.toml`, which this project now includes (see "Fixing the `moc`/`mo:base` build error" below) |
| `lib/backendClient.js` in the frontend | **Temporary mock**: an in-memory canister inside the tab, with the exact same interface and state machine as `main.mo` (Pending/Verified/Expired, replay rejection). Once the real canister is deployed, the swap is mechanical (same function names) — see the comment at the top of the file |
| Passkey sign-in (Memphis) | Mocked: pick from a list of ready-made identities instead of a real sign-in |

## UI/UX — built and actually tested

- **"Citizen" tab**: pick a mock identity → paste a Challenge → "Generate proof" button (spinner while proving/recording) → success/rejection banner + the proof payload (JSON), ready to copy.
- **"Company & Verify" tab**: create a Challenge under a company name → public verification page (Challenge + Proof only) → "Identity verified ✅" or the exact rejection reason (wrong challenge, wrong root, replay, ...).
- **"Canister Status" tab**: developer-only, to watch Challenge and nullifier state during a demo.
- Full English/LTR layout, IBM Plex Sans for text and IBM Plex Mono for technical values (the root, the nullifier), no pre-built UI kit.

### Testing that was actually done

1. **`npm run build`** in `frontend/` succeeds with no errors (Vite, React 19).
2. **`frontend/scripts/smoke_test.mjs`**: a script that runs **the exact same UI logic** (the same `challengeToField` function, the same proof generation/verification flow, the same mock-canister state machine) against **the same** `wasm`/`zkey`/`vkey`/`mock_registry.json` files the browser actually loads. Result: **9 of 9 tests passed**:
   - An adult citizen's proof is accepted, and the root/challenge in `publicSignals` match the canister.
   - `groth16.verify` succeeds cryptographically.
   - Replaying the same proof against the same Challenge is **rejected**.
   - The same citizen with a different Challenge gets a **completely different, unlinkable** nullifier.
   - A minor (age 11) **cannot generate a proof at all** (the circuit's age constraint fails).
   - A proof "forged" for the wrong challenge is rejected before it even reaches the cryptographic check.
   Run it yourself: `cd frontend && node scripts/smoke_test.mjs`
3. **Honest testing limits**: downloading a headless browser (Playwright/Chromium) was blocked by this environment's network restrictions (`cdn.playwright.dev` isn't allowed), so there is no screenshot or real DOM test. What was verified is **the exact code the UI runs**, not a visual snapshot of the UI itself. To confirm visually yourself: `cd frontend && npm install && npm run dev` and open it in your browser.

## Running locally

### Backend (build the circuit + mock data)

```bash
cd backend
npm install
npm run compile:circuit     # builds build_v2/identity_proof.{r1cs,wasm,sym}
npm run setup:trusted       # local trusted setup (Groth16) — produces identity_proof_final.zkey + verification_key.json
npm run mock:registry       # builds an 8-citizen Merkle tree and publishes the root
npm run demo:node           # (optional) run the full flow from Node, no UI
```

After any change to the circuit, copy `build_v2/identity_proof_js/identity_proof.wasm`,
`build_v2/identity_proof_final.zkey`, `build_v2/verification_key.json`, and
`build_v2/mock_registry.json` into `frontend/public/circuit/` so the UI picks
up the new build.

### Frontend

```bash
cd frontend
npm install
npm run dev      # opens on http://localhost:5173
npm run build    # produces frontend/dist, ready to deploy
```

## Fixing the `moc`/`mo:base` build error

If `thebes-deploy build` or `thebes-deploy deploy` fails with:

```
backend/main.mo:32.1-32.29: import error [M0010], package "base" not defined
```

it means `moc` was invoked without a package mapping for `mo:base/*`. This
project's root now ships a `mops.toml`:

```toml
[dependencies]
base = "0.14.8"
```

and `thebes.toml`'s backend build command was updated to inject the package
flags `mops sources` generates:

```toml
build = "mkdir -p backend/build && moc $(mops sources) --legacy-persistence -o backend/build/backend.wasm backend/main.mo"
```

Before building, install the Motoko package manager and fetch the
dependency once:

```bash
npm i -g ic-mops     # if you don't already have mops
mops install         # reads mops.toml, populates .mops/ locally
thebes-deploy build
```

## Deploying to THEBES

`thebes.toml` at the project root is ready, but before the first deploy you need:

1. `cid = "auto"` on both canisters (already set) — the first `thebes-deploy deploy` allocates real ids and writes them back into the same file.
2. `moc`/`mops` installed (see [docs/deploying.md](https://github.com/Mercatura-Forum/Thebes-Protocol-/blob/main/docs/deploying.md) in the official protocol repo), plus `mops install` as described above.
3. `asset_canister.wasm` downloaded once from the [official releases](https://github.com/Mercatura-Forum/Thebes-Protocol-/releases/tag/asset-canister-v0.1.0) and placed at the project root (as `thebes.toml` expects). This file is **not** produced by `thebes-deploy build` — it's a separate release artifact. Run the included helper (fetches + verifies the checksum):

```bash
./fetch_asset_canister.sh
```

or do it manually:

```bash
curl -fL -o asset_canister.wasm \
  https://github.com/Mercatura-Forum/Thebes-Protocol-/releases/download/asset-canister-v0.1.0/asset_canister.wasm
echo "6b72e4fe96b0439e37e485b0bcbf5ac7ccda3a2fd51e39b3e9aa8f276bd55b77  asset_canister.wasm" | sha256sum -c -
```

```bash
mops install
thebes-deploy identity new me
thebes-deploy deploy backend     # builds main.mo, deploys it, returns the cid
cd frontend && npm run build && cd ..
thebes-deploy deploy web         # uploads frontend/dist as the asset canister
```

After deployment, `lib/backendClient.js` needs to be wired up to the real
canister (instead of today's mock) via `@thebes/sdk` — the functions have the
exact same names (`createChallenge`, `consumeNullifier`, ...), so the swap
lives in a single file with no changes required in any UI page.

Note: passkey sign-in pins its relying-party id to the served origin, so it
will not work from `npm run dev` on localhost once wired to the real Memphis
flow — test sign-in on the deployed `*.mercaturaforum.com/_/raw/<cid>/...`
URL instead.

## Honest limits of this PoC

- **The trusted setup is local**, not a multi-party trusted ceremony — good enough to demonstrate the concept, not for production.
- **Groth16 proof verification happens off-chain** (in the company's browser via snarkjs), not inside the THEBES canister itself. The canister only guarantees **replay prevention** (via the nullifier), not the correctness of the math.
- **All 8 citizens' data is fully mocked** — the one file that should change once a real institution integration exists (verifying an uploaded ID photo + selfie) is `backend/scripts/build_mock_registry.js` (or a service that replaces it).
- **`backend/main.mo` has not actually been compiled** in this environment (no `moc` available here) — the code is complete and matches the interface `frontend/src/lib/backendClient.js` expects exactly. The `mops.toml`/`thebes.toml` fix above addresses the compile error reported when building elsewhere.
- **`lib/backendClient.js` is a temporary mock** until the real canister is deployed and swapped in via `@thebes/sdk`.
- **No real browser test (screenshot/DOM)** exists, due to this development environment's network restrictions — only a comprehensive logic test of the exact same code (`frontend/scripts/smoke_test.mjs`).
