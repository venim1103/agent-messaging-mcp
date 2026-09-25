import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { NATIVE_HOST_NAME } from "./native-protocol.js";

export type NativeRegistration = {
  manifestPath: string;
  manifest: string;
  launcherPath: string;
  launcher: string;
  origin: string;
};

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function profileDirectory(home: string, userDataDir?: string): string {
  const directory = userDataDir ?? join(home, ".config/chromium");
  const withinHome = relative(home, directory);
  if (!isAbsolute(directory) || withinHome === ".." || withinHome.startsWith(`..${sep}`)
    || isAbsolute(withinHome)) {
    throw new Error("Chromium user-data directory must be an absolute path inside the user's home");
  }
  return directory;
}

export function nativeManifestPath(home: string, userDataDir?: string): string {
  return join(profileDirectory(home, userDataDir), "NativeMessagingHosts", `${NATIVE_HOST_NAME}.json`);
}

export function planNativeRegistration(home: string, extensionId: string, nodePath: string,
  relayPath: string, userDataDir?: string): NativeRegistration {
  if (!/^[a-p]{32}$/.test(extensionId) || !isAbsolute(nodePath) || !isAbsolute(relayPath)) {
    throw new Error("Expected a Chromium extension ID and absolute Node/relay paths");
  }

  const origin = `chrome-extension://${extensionId}/`;
  const launcherPath = join(home, ".config/agent-messaging-mcp/native-host");
  return {
    manifestPath: nativeManifestPath(home, userDataDir),
    manifest: `${JSON.stringify({
      name: NATIVE_HOST_NAME,
      description: "Browser Chat MCP development bridge",
      path: launcherPath,
      type: "stdio",
      allowed_origins: [origin]
    }, null, 2)}\n`,
    launcherPath,
    launcher: `#!/bin/sh\nexec ${shellQuote(nodePath)} ${shellQuote(relayPath)} ${shellQuote(origin)} "$@"\n`,
    origin
  };
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

export async function registerNative(plan: NativeRegistration, previewOnly = false): Promise<void> {
  const [manifest, launcher] = await Promise.all([
    readIfPresent(plan.manifestPath), readIfPresent(plan.launcherPath)
  ]);
  if ((manifest !== null && manifest !== plan.manifest) || (launcher !== null && launcher !== plan.launcher)) {
    throw new Error("Refusing to replace an existing native host registration or launcher");
  }
  if (previewOnly) return;

  await mkdir(dirname(plan.launcherPath), { recursive: true, mode: 0o700 });
  await mkdir(dirname(plan.manifestPath), { recursive: true, mode: 0o700 });
  if (launcher === null) await writeFile(plan.launcherPath, plan.launcher, { flag: "wx", mode: 0o700 });
  if (manifest === null) await writeFile(plan.manifestPath, plan.manifest, { flag: "wx", mode: 0o600 });
}

export async function unregisterNative(home: string, nodePath: string, relayPath: string,
  userDataDir?: string, previewOnly = false): Promise<NativeRegistration | null> {
  const manifestPath = nativeManifestPath(home, userDataDir);
  const manifest = await readIfPresent(manifestPath);
  if (manifest === null) return null;

  let extensionId: string | undefined;
  try {
    const parsed = JSON.parse(manifest) as { allowed_origins?: unknown };
    const origin = Array.isArray(parsed.allowed_origins) ? parsed.allowed_origins[0] : null;
    extensionId = typeof origin === "string"
      ? /^chrome-extension:\/\/([a-p]{32})\/$/.exec(origin)?.[1] : undefined;
  } catch {
    throw new Error("Refusing to remove an unrecognized native host registration");
  }
  if (!extensionId) throw new Error("Refusing to remove an unrecognized native host registration");

  const plan = planNativeRegistration(home, extensionId, nodePath, relayPath, userDataDir);
  const launcher = await readIfPresent(plan.launcherPath);
  if (manifest !== plan.manifest || (launcher !== null && launcher !== plan.launcher)) {
    throw new Error("Refusing to remove an unrecognized native host registration or launcher");
  }
  if (!previewOnly) {
    await unlink(plan.manifestPath);
    if (launcher !== null) await unlink(plan.launcherPath);
  }
  return plan;
}

export async function restoreNative(home: string, nodePath: string, relayPath: string,
  userDataDir?: string, previewOnly = false): Promise<NativeRegistration | null> {
  const plan = await unregisterNative(home, nodePath, relayPath, userDataDir, true);
  if (plan && !previewOnly) await registerNative(plan);
  return plan;
}