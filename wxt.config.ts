import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  // Our libraries live under src/lib (per knowledge.md structure). WXT's
  // default '@/…' alias points at the project root; remap it to src/ so
  // '@/lib/…' resolves to src/lib/… everywhere (IDE, tsc, Vite).
  alias: {
    '@/': './src/',
  },
  manifest: {
    // Narrowest permissions:
    // - storage: validated storage service (browser.storage.local).
    // - activeTab: access to the CURRENT tab only, granted by the user
    //   clicking the toolbar icon (which opens the popup). No host
    //   permissions, no persistent page access.
    // - scripting: injects our capture content script into that one tab on
    //   demand (activeTab-scoped). No crawling, no background reads.
    permissions: ['storage', 'activeTab', 'scripting'],
  },
});
