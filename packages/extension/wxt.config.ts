import { defineConfig } from "wxt";

export default defineConfig({
  manifest: {
    name: "Browser Chat MCP (draft input test)",
    description: "Inspect a selected chat read-only and fill only user-approved test drafts; does not invoke Send.",
    permissions: ["activeTab", "scripting", "nativeMessaging", "debugger"]
  }
});