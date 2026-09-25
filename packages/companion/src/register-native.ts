import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { planNativeRegistration, registerNative, restoreNative, unregisterNative } from "./native-registration.js";

async function main() {
  const action = process.argv[2];
  let browser: string | undefined;
  let extensionId: string | undefined;
  let userDataDir: string | undefined;
  let previewOnly = false;

  for (let index = 3; index < process.argv.length; index++) {
    const option = process.argv[index];
    if (option === "--preview") {
      previewOnly = true;
    } else if (option === "--browser" || option === "--extension-id" || option === "--user-data-dir") {
      const value = process.argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${option}`);
      if (option === "--browser") browser = value;
      if (option === "--extension-id") extensionId = value;
      if (option === "--user-data-dir") userDataDir = value;
    } else {
      throw new Error(`Unrecognized option: ${option}`);
    }
  }

  if (process.platform !== "linux" || browser !== "chromium"
    || (action !== "register" && action !== "unregister" && action !== "restore")) {
    throw new Error("This development helper supports only register/unregister/restore --browser chromium on Linux");
  }

  const home = homedir();
  const relayPath = fileURLToPath(new URL("./native-relay.js", import.meta.url));
  await access(relayPath, constants.R_OK);

  if (action === "register") {
    if (!extensionId) throw new Error("--extension-id must be the ID shown by container Chromium");
    const plan = planNativeRegistration(home, extensionId, process.execPath, relayPath, userDataDir);
    await registerNative(plan, true);
    process.stdout.write(`Native host registration ${previewOnly ? "preview" : "plan"}:\n`
      + `  Manifest: ${plan.manifestPath}\n  Launcher: ${plan.launcherPath}\n`
      + `  Node: ${process.execPath}\n  Relay: ${relayPath}\n  Allowed origin: ${plan.origin}\n`);
    if (!previewOnly) {
      await registerNative(plan);
      process.stdout.write("Registered.\n");
    }
  } else {
    if (extensionId) throw new Error(`${action} does not accept --extension-id`);
    const plan = action === "restore"
      ? await restoreNative(home, process.execPath, relayPath, userDataDir, true)
      : await unregisterNative(home, process.execPath, relayPath, userDataDir, true);
    if (!plan) {
      process.stdout.write(action === "restore"
        ? "No prior native host registration to restore.\n"
        : "No application native host registration found.\n");
      return;
    }
    process.stdout.write(`Native host ${action === "restore" ? "restoration" : "removal"} ${previewOnly ? "preview" : "plan"}:\n`
      + `  Manifest: ${plan.manifestPath}\n  Launcher: ${plan.launcherPath}\n`
      + (action === "restore" ? `  Allowed origin: ${plan.origin}\n` : ""));
    if (!previewOnly) {
      if (action === "restore") {
        await restoreNative(home, process.execPath, relayPath, userDataDir);
        process.stdout.write("Restored.\n");
      } else {
        await unregisterNative(home, process.execPath, relayPath, userDataDir);
        process.stdout.write("Unregistered.\n");
      }
    }
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Native host registration failed"}\n`);
  process.exitCode = 1;
});