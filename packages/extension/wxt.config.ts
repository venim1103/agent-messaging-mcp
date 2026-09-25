import { defineConfig } from "wxt";

export default defineConfig({
  manifest: {
    name: "Browser Chat MCP (read-only probe)",
    description: "Inspect a selected local fixture or Gemini chat structure with a read-only popup.",
    permissions: ["activeTab", "scripting", "nativeMessaging"]
  }
});