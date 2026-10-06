import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { createFixtureServer } from "./server.mjs";

test("fixture server refuses malformed targets without rejecting or disclosing them", async () => {
  const server = createFixtureServer();
  const handler = server.listeners("request")[0];
  for (const target of ["http://[private-fixture-target", "http://private-fixture-target:bad/",
    "http://%zz/", "http://127.0.0.1:99999/"]) {
    const statuses = [];
    const bodies = [];
    const response = {
      writeHead(status) { statuses.push(status); },
      end(body) { bodies.push(body); }
    };
    await assert.doesNotReject(handler({ method: "GET", url: target }, response));
    assert.deepEqual(statuses, [400]);
    assert.deepEqual(bodies, ["Invalid request"]);
  }
});

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