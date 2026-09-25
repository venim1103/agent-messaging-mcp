import { defineConfig } from "wxt";

export default defineConfig({
  manifest: {
    name: "Browser Chat MCP (fixture input test)",
    description: "Inspect a selected chat read-only; test debugger input only on the local rich fixture.",
    permissions: ["activeTab", "scripting", "nativeMessaging", "debugger"]
  }
});