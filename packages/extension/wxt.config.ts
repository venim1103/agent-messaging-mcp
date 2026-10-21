import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineConfig } from "wxt";
import { fingerprintExtension } from "./build-fingerprint";

export default defineConfig({
  hooks: {
    "build:done": async (wxt, output) => {
      if (wxt.config.command === "serve") return;
      const files = [...output.publicAssets, ...output.steps.flatMap(step => step.chunks)].map(file => file.fileName);
      const fingerprint = await fingerprintExtension(wxt.config.outDir, files, output.manifest);
      const manifest = { ...output.manifest, version_name: `${output.manifest.version}+sha256.${fingerprint}` };
      await writeFile(join(wxt.config.outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    }
  },
  manifest: {
    name: "Browser Chat MCP",
    description: "Connect an approved agent to one selected chat for reading and sending.",
    permissions: ["activeTab", "scripting", "nativeMessaging", "storage"],
    optional_host_permissions: ["http://127.0.0.1:8787/*", "https://gemini.google.com/*"]
  }
});