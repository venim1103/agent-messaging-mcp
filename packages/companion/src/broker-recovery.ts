import { randomUUID } from "node:crypto";
import { lstat, readdir, rename, rmdir, unlink } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";

export async function recoverStaleBrokerRuntime(parent: string): Promise<boolean> {
  const directory = join(parent, "broker");
  let info;
  try {
    info = await lstat(directory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
  const owner = process.getuid?.();
  if (!info.isDirectory() || info.uid !== owner || (info.mode & 0o077) !== 0) {
    throw new Error("Refusing to recover an unrecognized broker directory");
  }
  const expected = ["broker.sock", "facade.key", "relay.key"];
  const names = await readdir(directory);
  if (names.length !== expected.length || expected.some((name) => !names.includes(name))) {
    throw new Error("Refusing to recover unexpected broker runtime files");
  }
  const paths = expected.map((name) => join(directory, name));
  const [socketInfo, facadeInfo, relayInfo] = await Promise.all(paths.map((path) => lstat(path)));
  if (!socketInfo?.isSocket() || socketInfo.uid !== owner || (socketInfo.mode & 0o077) !== 0
    || !facadeInfo?.isFile() || facadeInfo.uid !== owner || (facadeInfo.mode & 0o077) !== 0 || facadeInfo.size !== 64
    || !relayInfo?.isFile() || relayInfo.uid !== owner || (relayInfo.mode & 0o077) !== 0 || relayInfo.size !== 64) {
    throw new Error("Refusing to recover unsafe broker runtime files");
  }

  const stale = await new Promise<boolean>((resolve, reject) => {
    const probe = connect(paths[0]!);
    probe.setTimeout(1000, () => probe.destroy(new Error("Broker socket probe timed out")));
    probe.once("connect", () => { probe.destroy(); resolve(false); });
    probe.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED") resolve(true);
      else reject(error);
    });
  });
  if (!stale) throw new Error("Broker is already running");

  const quarantined = join(parent, `broker-stale-${randomUUID()}`);
  await rename(directory, quarantined);
  const moved = await lstat(quarantined);
  if (moved.dev !== info.dev || moved.ino !== info.ino) {
    await rename(quarantined, directory).catch(() => {});
    throw new Error("Broker runtime changed during recovery");
  }
  const movedFiles = expected.map((name) => join(quarantined, name));
  const currentFiles = await Promise.all(movedFiles.map((path) => lstat(path)));
  if (currentFiles.some((file, index) => file.dev !== [socketInfo, facadeInfo, relayInfo][index]?.dev
    || file.ino !== [socketInfo, facadeInfo, relayInfo][index]?.ino)) {
    throw new Error("Broker runtime files changed during recovery");
  }
  for (const path of movedFiles) await unlink(path);
  await rmdir(quarantined);
  return true;
}