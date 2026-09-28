import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { captureFixtureSnapshot, observeFixtureMessages } from "../../packages/extension/lib/fixture-observation.ts";
import { createFixtureServer } from "../fixtures/server.mjs";

test("browser input reaches the rich editor without accepting synthetic input", async () => {
  const server = createFixtureServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  let browser;

  try {
    browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true });
    const page = await browser.newPage();
    const url = `http://127.0.0.1:${server.address().port}/`;
    await page.goto(`${url}?editor=rich`);

    const editor = page.getByRole("textbox", { name: "Message" });
    await editor.evaluate((element) => {
      element.textContent = "Synthetic input";
      element.dispatchEvent(new InputEvent("input", { bubbles: true, data: "Synthetic input" }));
    });
    await page.getByRole("button", { name: "Send" }).click();
    assert.equal(await page.locator('ol[role="log"] > li').count(), 2);

    await editor.fill("");
    await editor.pressSequentially("First line");
    await editor.press("Shift+Enter");
    await editor.pressSequentially("Second line \uD83D\uDE00");
    const text = "First line\nSecond line \uD83D\uDE00";
    assert.equal(await editor.innerText(), text);

    await page.getByRole("button", { name: "Send" }).click();
    assert.equal(await page.locator('ol[role="log"] > li').count(), 3);
    assert.equal(await page.locator('ol[role="log"] > li:last-child p').textContent(), text);
    assert.equal(await editor.innerText(), "");

    await page.goto(url);
    await page.getByRole("textbox", { name: "Message" }).fill("Textarea message");
    await page.getByRole("button", { name: "Send" }).click();
    assert.equal(await page.locator('ol[role="log"] > li:last-child p').textContent(), "Textarea message");

    await page.getByRole("button", { name: "Switch chat" }).click();
    assert.equal(page.url(), url);
    assert.equal(await page.locator("main").getAttribute("data-conversation-id"), "fixture-beta");
    assert.equal(await page.locator('ol[role="log"] > li p').textContent(), "A different local conversation.");
  } finally {
    await browser?.close();
    server.close();
    await once(server, "close");
  }
});

test("fixture observation captures bounded rows and notices changes without reading another chat", async () => {
  const html = await readFile(new URL("../fixtures/chat.html", import.meta.url), "utf8");
  const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true });
  try {
    const page = await browser.newPage();
    await page.route("http://127.0.0.1:8787/**", (route) => route.fulfill({
      status: 200, contentType: "text/html", body: html
    }));
    await page.goto("http://127.0.0.1:8787/");
    assert.deepEqual(await page.evaluate(captureFixtureSnapshot), { messages: [
      { id: "fixture-1", direction: "incoming", text: "Can you read this message?" },
      { id: "fixture-2", direction: "outgoing", text: "Yes. This is a local test conversation." }
    ] });
    await page.evaluate(() => {
      window.fixtureNotifications = [];
      window.chrome = { runtime: { sendMessage: (message) => {
        window.fixtureNotifications.push(message);
        return Promise.resolve();
      } } };
    });
    assert.equal(await page.evaluate(observeFixtureMessages), true);
    await page.getByRole("textbox", { name: "Message" }).fill("Third message");
    await page.getByRole("button", { name: "Send" }).click();
    await page.waitForFunction(() => window.fixtureNotifications.length > 0);
    assert.equal((await page.evaluate(captureFixtureSnapshot)).messages[2].text, "Third message");
    await page.locator('li[data-message-id="fixture-3"]').evaluate((row) => {
      row.dataset.messageId = "fixture-2";
    });
    assert.equal(await page.evaluate(captureFixtureSnapshot), null);
    await page.getByRole("button", { name: "Switch chat" }).click();
    assert.equal(await page.evaluate(captureFixtureSnapshot), null);
    await page.goto("http://127.0.0.1:8787/");
    await page.locator("ol#messages").evaluate((timeline) => timeline.insertAdjacentHTML("beforeend",
      '<li data-message-id="large" data-direction="incoming"><p>' + "x".repeat(2049) + "</p></li>"));
    assert.equal(await page.evaluate(captureFixtureSnapshot), null);
    await page.goto("about:blank");
    assert.equal(await page.evaluate(captureFixtureSnapshot), null);
  } finally {
    await browser.close();
  }
});