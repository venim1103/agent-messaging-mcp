import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineConfig } from "wxt";
import { loadEnv } from "vite";
import { fingerprintExtension, verifyExtensionBuild } from "./build-fingerprint";
import { configuredDatabagOrigins } from "./lib/provider-origins";

const environment = loadEnv("production", import.meta.dirname, "BROWSER_CHAT_");
const databagOrigins = configuredDatabagOrigins(environment.BROWSER_CHAT_DATABAG_ORIGIN);

export default defineConfig({
  zip: { name: "browser-chat-mcp", zipSources: false },
  vite: () => ({ define: { __DATABAG_ORIGINS__: JSON.stringify(databagOrigins) } }),
  hooks: {
    "build:done": async (wxt, output) => {
      if (wxt.config.command === "serve") return;
      const files = [...output.publicAssets, ...output.steps.flatMap(step => step.chunks)].map(file => file.fileName);
      const fingerprint = await fingerprintExtension(wxt.config.outDir, files, output.manifest);
      const manifest = { ...output.manifest, version_name: `${output.manifest.version}+sha256.${fingerprint}` };
      await writeFile(join(wxt.config.outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    },
    "zip:extension:start": async (wxt) => {
      await verifyExtensionBuild(wxt.config.outDir);
    }
  },
  manifest: {
    name: "Browser Chat MCP",
    description: "Connect an approved agent to one selected chat for reading and sending.",
    permissions: ["activeTab", "scripting", "nativeMessaging", "storage"],
    optional_host_permissions: ["http://127.0.0.1:8787/*", "https://gemini.google.com/*",
      ...databagOrigins.map(origin => `${origin}/*`)]
  }
});