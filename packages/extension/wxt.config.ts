import { defineConfig } from "wxt";

export default defineConfig({
  manifest: {
    name: "Browser Chat MCP (draft input test)",
    description: "Inspect a selected chat read-only and fill only user-approved test drafts; does not invoke Send.",
    permissions: ["activeTab", "scripting", "nativeMessaging", "debugger", "storage"],
    optional_host_permissions: ["http://127.0.0.1:8787/*", "https://gemini.google.com/*"]
  }
});