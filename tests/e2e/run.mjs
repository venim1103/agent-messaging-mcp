import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTestExtension } from "./extension-harness.mjs";

const serialPattern = "^(private fixture submit activates once|worker and broker crashes after fixture activation|test-only Gemini host access|read-only Gemini draft inspection|(?:fixture|gemini) popup roster removes one agent)";

export const testGroups = [
  { name: "Independent browser cases", concurrency: 2, filter: `--test-skip-pattern=${serialPattern}` },
  { name: "Composite browser cases", concurrency: 1, filter: `--test-name-pattern=${serialPattern}` }
];

if (import.meta.main) {
  const directory = fileURLToPath(new URL("./", import.meta.url));
  const files = readdirSync(directory).filter(name => name.endsWith(".test.mjs")).sort().map(name => join(directory, name));
  const started = performance.now();
  const build = await buildTestExtension("");
  try {
    for (const group of testGroups) {
      console.log(`${group.name}: ${group.concurrency} worker(s)`);
      const result = spawnSync(process.execPath, ["--test", `--test-concurrency=${group.concurrency}`, group.filter, ...files], {
        stdio: "inherit", env: { ...process.env, BROWSER_CHAT_DATABAG_ORIGIN: "",
          BROWSER_CHAT_TEST_EXTENSION_DIRECTORY: build.directory }
      });
      if (result.error) throw result.error;
      if (result.status !== 0) { process.exitCode = result.status ?? 1; break; }
    }
    if (!process.exitCode) console.log(`E2E total: ${Math.round(performance.now() - started)} ms`);
  } finally {
    await rm(build.source, { recursive: true, force: true });
  }
}