import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  // THEBES serves the built app under a per-canister subpath
  // (https://memphis.mercaturaforum.com/_/raw/<cid>/...), not the domain
  // root. An absolute base (Vite's default, "/") makes every asset URL in
  // index.html resolve to the domain root instead of that subpath, which is
  // exactly the 404s you get in the browser console. A relative base makes
  // every asset reference relative to index.html's own location instead, so
  // it works under any subpath without needing to know the cid in advance.
  base: './',
  plugins: [react()],
})
