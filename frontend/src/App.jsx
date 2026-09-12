import { useEffect, useState } from "react";
import CitizenPage from "./pages/CitizenPage.jsx";
import CompanyPage from "./pages/CompanyPage.jsx";
import StatusPage from "./pages/StatusPage.jsx";
import { backend } from "./lib/backendClient.js";
import { loadMockRegistry } from "./lib/zk.js";

const TABS = [
  { id: "citizen", label: "Citizen" },
  { id: "company", label: "Company & Verify" },
  { id: "status", label: "Canister Status" },
];

export default function App() {
  const [tab, setTab] = useState("citizen");
  const [root, setRoot] = useState(null);

  useEffect(() => {
    (async () => {
      const registry = await loadMockRegistry();
      await backend.registerIdentityRoot(registry.root);
      setRoot(registry.root);
    })();
  }, []);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <svg className="brand-mark" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
            <rect width="64" height="64" rx="12" fill="#191d24" />
            <path d="M8 32c6-10 14-15 24-15s18 5 24 15c-6 10-14 15-24 15S14 42 8 32z" fill="none" stroke="#c9a24b" strokeWidth="3" />
            <circle cx="32" cy="32" r="7" fill="#c9a24b" />
          </svg>
          <div>
            <h1>Zero-Knowledge Identity Proof — THEBES PoC</h1>
            <p>I am 18 or older, without revealing my date of birth or exactly who I am</p>
          </div>
        </div>
        <div className="root-badge">
          <span className={`dot ${root ? "on" : "off"}`} />
          <span>identityRoot:</span>
          <span className="val">{root ? `${root.slice(0, 18)}…` : "publishing…"}</span>
        </div>
      </header>

      <nav className="tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`tab-btn ${tab === t.id ? "active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === "citizen" && <CitizenPage />}
      {tab === "company" && <CompanyPage />}
      {tab === "status" && <StatusPage />}
    </div>
  );
}
