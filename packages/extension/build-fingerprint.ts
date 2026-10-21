import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function fingerprintExtension(directory: string, fileNames: readonly string[], manifest: Record<string, unknown>): Promise<string> {
  const metadata = { ...manifest };
  delete metadata.version_name;
  const hash = createHash("sha256").update("browser-chat-extension-build-v1\0");
  const manifestBytes = Buffer.from(JSON.stringify(metadata));
  hash.update(JSON.stringify(["manifest.json", manifestBytes.length])).update(manifestBytes);
  for (const fileName of [...new Set(fileNames)].filter(name => name !== "manifest.json").sort()) {
    const content = await readFile(join(directory, fileName));
    hash.update(JSON.stringify([fileName, content.length])).update(content);
  }
  return hash.digest("hex");
}