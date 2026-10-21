import { fileURLToPath } from "node:url";
import { verifyExtensionBuild } from "./build-fingerprint.ts";

if (process.argv.length !== 2) {
  console.error("Usage: npm run verify:extension (no arguments)");
  process.exitCode = 1;
} else {
  try {
    const directory = fileURLToPath(new URL("./.output/chrome-mv3/", import.meta.url));
    const marker = await verifyExtensionBuild(directory);
    console.log(`Extension package verified: ${marker}`);
  } catch {
    console.error("Extension package verification failed. Rebuild with npm run build:extension before loading it.");
    process.exitCode = 1;
  }
}