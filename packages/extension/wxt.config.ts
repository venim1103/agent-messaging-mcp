import { defineConfig } from "wxt";

export default defineConfig({
  manifest: {
    name: "Browser Chat MCP",
    description: "Connect an approved agent to one selected chat for reading and sending.",
    permissions: ["activeTab", "scripting", "nativeMessaging", "storage"],
    optional_host_permissions: ["http://127.0.0.1:8787/*", "https://gemini.google.com/*"]
  }
});