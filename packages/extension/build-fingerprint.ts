import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { join, posix, resolve } from "node:path";

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

export async function verifyExtensionBuild(directory: string): Promise<string> {
  if (!(await lstat(directory)).isDirectory() || await realpath(directory) !== resolve(directory)) {
    throw new Error("Extension package directory must be a real directory.");
  }
  const files: string[] = [];
  const pending = [""];
  while (pending.length) {
    const parent = pending.pop()!;
    for (const entry of await readdir(join(directory, parent), { withFileTypes: true })) {
      const name = posix.join(parent, entry.name);
      if (entry.isDirectory()) pending.push(name);
      else if (entry.isFile()) files.push(name);
      else throw new Error("Extension package contains a non-regular entry.");
    }
  }
  const parsed: unknown = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Extension package manifest is invalid.");
  }
  const manifest = parsed as Record<string, unknown>;
  if (typeof manifest.version !== "string" || typeof manifest.version_name !== "string"
    || !/^\d+(?:\.\d+){0,3}\+sha256\.[0-9a-f]{64}$/.test(manifest.version_name)) {
    throw new Error("Extension package build marker is missing or invalid.");
  }
  const expected = `${manifest.version}+sha256.${await fingerprintExtension(directory, files, manifest)}`;
  if (manifest.version_name !== expected) throw new Error("Extension package build marker does not match packaged artifacts.");
  return expected;
}