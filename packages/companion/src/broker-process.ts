import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createBrokerCredentials } from "./broker-roles.js";
import { startBrokerSocket } from "./broker-ipc.js";

async function main(): Promise<void> {
  const parent = join(homedir(), ".config/agent-messaging-mcp");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const info = await stat(parent);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
    throw new Error("Broker runtime parent must be owned by this user and private");
  }

  const broker = await startBrokerSocket(join(parent, "broker"), createBrokerCredentials());
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    broker.close().then(() => process.exit(0)).catch(() => process.exit(1));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Broker startup failed"}\n`);
  process.exitCode = 1;
});