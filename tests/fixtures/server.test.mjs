import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { createFixtureServer } from "./server.mjs";

test("fixture server serves only the synthetic chat page on loopback", async () => {
  const server = createFixtureServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const page = await fetch(url);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /^text\/html/);
    assert.match(await page.text(), /data-conversation-id="fixture-alpha"/);

    const missing = await fetch(`${url}/other`);
    assert.equal(missing.status, 404);
  } finally {
    server.close();
    await once(server, "close");
  }
});