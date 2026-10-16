import { once } from "node:events";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const extensionDirectory = fileURLToPath(new URL("../../packages/extension/.output/chrome-mv3/", import.meta.url));

const nativeRelayPath = fileURLToPath(new URL("../../packages/companion/dist/native-relay.js", import.meta.url));

async function brokerSocketReady(socketPath) {
  try {
    const info = await stat(socketPath);
    return info.isSocket() && info.uid === process.getuid?.() && (info.mode & 0o077) === 0;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    return false;
  }
}

function trackTestPhase(testContext, label) {
  const started = performance.now();
  let phase = "preparing";
  testContext?.signal.addEventListener("abort", () => {
    testContext.diagnostic(`${label} at test end: ${phase} (${Math.round(performance.now() - started)} ms)`);
  }, { once: true });
  return next => {
    phase = next;
    testContext?.diagnostic(`${label}: ${phase} (${Math.round(performance.now() - started)} ms)`);
  };
}

export { extensionDirectory, nativeRelayPath, brokerSocketReady, trackTestPhase };
