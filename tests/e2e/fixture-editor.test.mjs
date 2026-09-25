import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { chromium } from "playwright-core";
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
  } finally {
    await browser?.close();
    server.close();
    await once(server, "close");
  }
});