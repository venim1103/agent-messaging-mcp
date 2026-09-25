import { defineConfig } from "wxt";

export default defineConfig({
  manifest: {
    name: "Browser Chat MCP (fixture probe)",
    description: "Inspect the selected local chat fixture with a read-only browser popup.",
    permissions: ["activeTab", "scripting", "nativeMessaging"]
  }
});