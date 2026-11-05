import { once } from "node:events";
import { execFile } from "node:child_process";
import { cp, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const extensionDirectory = process.env.BROWSER_CHAT_TEST_EXTENSION_DIRECTORY
  ?? fileURLToPath(new URL("../../packages/extension/.output/chrome-mv3/", import.meta.url));

const nativeRelayPath = fileURLToPath(new URL("../../packages/companion/dist/native-relay.js", import.meta.url));

async function buildTestExtension(origin, signal, companyAIOrigin = "") {
  const sourceRoot = fileURLToPath(new URL("../../packages/extension/", import.meta.url));
  const source = await mkdtemp(join(tmpdir(), "agent-messaging-extension-build-"));
  try {
    await cp(sourceRoot, source, { recursive: true, filter: entry => !relative(sourceRoot, entry).split("/")
      .some(part => ["node_modules", ".output", ".wxt"].includes(part) || part.startsWith(".env")) });
    await symlink(fileURLToPath(new URL("../../node_modules", import.meta.url)), join(source, "node_modules"), "dir");
    const cli = fileURLToPath(new URL("../../node_modules/wxt/bin/wxt.mjs", import.meta.url));
    await promisify(execFile)(process.execPath, [cli, "build"], { cwd: source, signal,
      env: { ...process.env, BROWSER_CHAT_DATABAG_ORIGIN: origin, BROWSER_CHAT_COMPANY_AI_ORIGIN: companyAIOrigin } });
    return { source, directory: join(source, ".output/chrome-mv3") };
  } catch (error) {
    await rm(source, { recursive: true, force: true });
    throw error;
  }
}

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

async function traceBrowserJobs(worker, emit = false) {
  await worker.evaluate(emit => {
    globalThis.browserJobTrace = [];
    const started = performance.now();
    const record = event => {
      globalThis.browserJobTrace.push({ ...event, atMs: Math.round(performance.now() - started) });
      if (globalThis.browserJobTrace.length > 32) globalThis.browserJobTrace.shift();
      if (emit) console.info(`synthetic-browser-job:${JSON.stringify(globalThis.browserJobTrace.at(-1))}`);
    };
    const connect = chrome.runtime.connectNative.bind(chrome.runtime);
    chrome.runtime.connectNative = (...args) => {
      const port = connect(...args);
      port.onMessage.addListener(reply => {
        for (const job of reply.payload?.jobs ?? reply.payload?.checks ?? []) record({ event: "offer",
          kind: reply.kind, remainingMs: job.expiresAt - Date.now() });
        for (const challenge of reply.payload?.challenges ?? []) record({ event: "read_challenge",
          kind: reply.kind, remainingMs: challenge.expiresAt - Date.now() });
        if (reply.kind.endsWith("_recorded") && typeof reply.payload?.accepted === "boolean") record({ event: "acknowledgement",
          kind: reply.kind, accepted: reply.payload.accepted, remainingMs: reply.deadlineMs - Date.now() });
        if (reply.kind === "chat_snapshot_published") record({ event: "snapshot_acknowledgement",
          count: reply.payload.count, remainingMs: reply.deadlineMs - Date.now() });
      });
      const post = port.postMessage.bind(port);
      port.postMessage = message => {
        const observation = message.payload?.observation ?? message.payload?.result;
        if (message.kind.startsWith("complete_") && observation) record({ event: "completion", kind: message.kind,
          phase: message.payload.phase, ok: observation.ok, code: observation.code, remainingMs: message.deadlineMs - Date.now() });
        if (message.kind === "publish_fixture_snapshot" || message.kind === "publish_gemini_snapshot"
          || message.kind === "publish_chat_snapshot") record({ event: "snapshot",
          challenged: !!message.payload.challengeId, rows: message.payload.messages?.length });
        post(message);
      };
      return port;
    };
  }, emit);
}

function installSyntheticGeminiProof() {
  globalThis.syntheticGeminiProofMode = "positive";
  globalThis.syntheticGeminiProofExecutions = 0;
  const execute = chrome.scripting.executeScript.bind(chrome.scripting);
  chrome.scripting.executeScript = async details => {
    const mode = globalThis.syntheticGeminiProofMode;
    const result = await execute(details);
    if (details.func.toString().includes(".checkSubmit")) {
      globalThis.syntheticGeminiProofExecutions++;
      if (mode === "result-loss") return [];
      if (mode === "grant-loss") {
        await chrome.storage.session.remove(`gemini-grant-${details.target.tabId}`);
      }
    }
    return result;
  };
}

export { extensionDirectory, nativeRelayPath, buildTestExtension, brokerSocketReady, trackTestPhase, traceBrowserJobs, installSyntheticGeminiProof };
