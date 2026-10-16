import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const serialPattern = "^(private fixture submit activates once|worker and broker crashes after fixture activation|test-only Gemini host access|read-only Gemini draft inspection|(?:fixture|gemini) popup roster removes one agent)";

export const testGroups = [
  { name: "Independent browser cases", concurrency: 2, filter: `--test-skip-pattern=${serialPattern}` },
  { name: "Composite browser cases", concurrency: 1, filter: `--test-name-pattern=${serialPattern}` }
];

if (import.meta.main) {
  const directory = fileURLToPath(new URL("./", import.meta.url));
  const files = readdirSync(directory).filter(name => name.endsWith(".test.mjs")).sort().map(name => join(directory, name));
  const started = performance.now();
  for (const group of testGroups) {
    console.log(`${group.name}: ${group.concurrency} worker(s)`);
    const result = spawnSync(process.execPath, ["--test", `--test-concurrency=${group.concurrency}`, group.filter, ...files], {
      stdio: "inherit"
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  console.log(`E2E total: ${Math.round(performance.now() - started)} ms`);
}