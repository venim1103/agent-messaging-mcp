import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { MAX_ACTIVE_PREPARED_MESSAGES, MAX_PREPARED_MESSAGE_BYTES,
  PreparedMessageOperations, PREPARED_MESSAGE_TTL_MS }
  from "./message-operations.js";
import { PendingConnectionRequests } from "./pending-connections.js";

test("fixture preparation persists no text and cannot dispatch without a trusted approval path", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-messaging-prepare-"));
  const path = join(home, "operations.sqlite");
  let database = new DatabaseSync(path);
  try {
    const requests = new PendingConnectionRequests();
    const owner = Symbol("MCP owner");
    const stranger = Symbol("other MCP client");
    const pending = requests.create(owner, 1000);
    const target = { origin: "http://127.0.0.1:8787" as const, conversationId: "fixture-alpha" as const,
      tabId: 3, documentId: "CHROME-doc_opaque-42" };
    const grant = requests.approve(pending.requestId, target, 2000)!;
    const ledger = new PreparedMessageOperations(requests, database);
    const key = "a66b3997-9d43-4554-8399-267d1fe9f75c";
    const text = "Synthetic private prepare-only text \u00e9";
    assert.throws(() => ledger.prepare(stranger, grant.connectionId, 1, text, key, 2001), /CONNECTION_NOT_FOUND/);
    assert.throws(() => ledger.prepare(owner, grant.connectionId, 2, text, key, 2001), /GENERATION_MISMATCH/);
    assert.throws(() => ledger.prepare(owner, grant.connectionId, 1, " ", key, 2001), /INVALID_MESSAGE_TEXT/);
    assert.throws(() => ledger.prepare(owner, grant.connectionId, 1,
      "\u00e9".repeat(MAX_PREPARED_MESSAGE_BYTES), key, 2001), /INVALID_MESSAGE_TEXT/);
    assert.throws(() => ledger.prepare(owner, grant.connectionId, 1, text, "not-a-uuid", 2001),
      /INVALID_IDEMPOTENCY_KEY/);
    const prepared = ledger.prepare(owner, grant.connectionId, 1, text, key, 2001);
    assert.equal(prepared.state, "awaiting_approval");
    assert.equal(prepared.preview.text, text);
    assert.equal(prepared.expiresAt, 2001 + PREPARED_MESSAGE_TTL_MS);
    assert.deepEqual(ledger.prepare(owner, grant.connectionId, 1, text, key, 2002), prepared);
    assert.throws(() => ledger.prepare(owner, grant.connectionId, 1, `${text}!`, key, 2002), /IDEMPOTENCY_CONFLICT/);
    assert.equal(database.prepare("SELECT count(*) AS count FROM prepared_message_operations").get()?.count, 1);
    assert.equal((await readFile(path)).includes(Buffer.from(text)), false);
    assert.equal((await readFile(path)).includes(Buffer.from(target.documentId)), false);
    assert.throws(() => ledger.prepare(owner, grant.connectionId, 1, text, key,
      prepared.expiresAt), /OPERATION_EXPIRED/);
    for (let index = 1; index <= MAX_ACTIVE_PREPARED_MESSAGES; index++) {
      ledger.prepare(owner, grant.connectionId, 1, `Fixture text ${index}`,
        `a66b3997-9d43-4554-8399-${String(index).padStart(12, "0")}`, 2002);
    }
    assert.throws(() => ledger.prepare(owner, grant.connectionId, 1, "Over capacity",
      "b66b3997-9d43-4554-8399-267d1fe9f75c", 2002), /TOO_MANY_PREPARED/);
    assert.equal(ledger.prepare(owner, grant.connectionId, 1, "After expiry",
      "b66b3997-9d43-4554-8399-267d1fe9f75c", prepared.expiresAt + 1).state, "awaiting_approval");
    requests.revokeChangedTab(3, null);
    assert.throws(() => ledger.prepare(owner, grant.connectionId, 1, text, key, 2003), /CONNECTION_NOT_FOUND/);
    ledger.disconnect(owner);
    database.close();
    database = new DatabaseSync(path);
    const restartedRequests = new PendingConnectionRequests();
    const restartedOwner = Symbol("fresh broker owner");
    const restartedPending = restartedRequests.create(restartedOwner, 1000);
    const restartedGrant = restartedRequests.approve(restartedPending.requestId, target, 2000)!;
    const restartedLedger = new PreparedMessageOperations(restartedRequests, database);
    assert.throws(() => restartedLedger.prepare(restartedOwner, restartedGrant.connectionId, 1, text, key, 2004),
      /OPERATION_UNAVAILABLE/);
    assert.equal(database.prepare("SELECT count(*) AS count FROM prepared_message_operations").get()?.count,
      MAX_ACTIVE_PREPARED_MESSAGES + 2);
  } finally {
    database.close();
    await rm(home, { recursive: true, force: true });
  }
});