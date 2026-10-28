import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { captureFixtureSnapshot, fillFixtureDraft, inspectFixturePreflight, observeFixtureMessages,
  submitFixtureDraft } from "../../packages/extension/lib/fixture-observation.ts";
import { PreparedMessageOperations } from "../../packages/companion/dist/message-operations.js";
import { PendingConnectionRequests } from "../../packages/companion/dist/pending-connections.js";
import { createFixtureServer } from "../fixtures/server.mjs";
import { installDraftOwnershipTracker } from "../../packages/extension/lib/draft-ownership.ts";
import { installDatabagAdapter, identifyDatabagConversation, captureDatabagSnapshot, observeDatabagMessages,
  inspectDatabagDraft, fillDatabagDraft, submitDatabagDraft }
  from "../../packages/extension/lib/databag-observation.ts";

test("Databag guarded submits activate once and never retry refused or uncertain outcomes", { timeout: 15000 }, async () => {
  const html = await readFile(new URL("../fixtures/databag.html", import.meta.url), "utf8");
  const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true, chromiumSandbox: true });
  try {
    const page = await browser.newPage();
    const expectedUrl = "https://databag.example/#/session";
    await page.route("https://databag.example/**", route => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto(expectedUrl);
    const reset = async () => {
      await page.reload();
      await page.evaluate(installDatabagAdapter, ["https://databag.example"]);
      await page.evaluate(installDraftOwnershipTracker);
      const identity = await page.evaluate(identifyDatabagConversation);
      const filling = { expectedUrl, conversationId: identity.conversationId, text: "Synthetic Databag activation",
        operationId: randomUUID(), attemptId: randomUUID(), expiresAt: Date.now() + 4000 };
      assert.equal((await page.evaluate(fillDatabagDraft, filling)).ok, true);
      return { ...filling, attemptId: filling.operationId, expiresAt: Date.now() + 4000 };
    };
    let input = await reset();
    assert.deepEqual(await page.evaluate(submitDatabagDraft, input), { ok: true, editor: "textarea", activated: true });
    assert.equal(await page.evaluate(() => window.syntheticActivations), 1);
    assert.equal(await page.locator("textarea").inputValue(), "");
    assert.equal((await page.evaluate(captureDatabagSnapshot, input.conversationId)).messages.at(-1).text, input.text);
    assert.deepEqual(await page.evaluate(submitDatabagDraft, { ...input, expiresAt: Date.now() + 4000 }),
      { ok: false, code: "DISPATCH_UNAVAILABLE" });
    assert.equal(await page.evaluate(() => window.syntheticActivations), 1);
    input = await reset();
    await page.locator("textarea").fill("Synthetic human edit");
    assert.deepEqual(await page.evaluate(submitDatabagDraft, input), { ok: false, code: "DRAFT_CHANGED" });
    assert.equal(await page.locator("textarea").inputValue(), "Synthetic human edit");
    assert.equal(await page.evaluate(() => window.syntheticActivations), 0);
    input = await reset();
    await page.locator("[data-chat-send]").evaluate(button => button.addEventListener("focus", () => {
      document.querySelector("[data-chat-contract]").dataset.chatAccount = "other-account";
    }, { once: true }));
    assert.deepEqual(await page.evaluate(submitDatabagDraft, input), { ok: false, code: "TARGET_CHANGED" });
    assert.equal(await page.locator("textarea").inputValue(), input.text);
    assert.equal(await page.evaluate(() => window.syntheticActivations), 0);
    input = await reset();
    await page.locator("[data-chat-send]").evaluate(button => { button.disabled = true; });
    assert.deepEqual(await page.evaluate(submitDatabagDraft, input), { ok: false, code: "SUBMIT_UNAVAILABLE" });
    await page.locator("[data-chat-send]").evaluate(button => { button.disabled = false; });
    assert.deepEqual(await page.evaluate(submitDatabagDraft, { ...input, expiresAt: Date.now() + 4000 }),
      { ok: false, code: "DISPATCH_UNAVAILABLE" });
    assert.equal(await page.evaluate(() => window.syntheticActivations), 0);
    input = await reset();
    assert.deepEqual(await page.evaluate(submitDatabagDraft, { ...input, expiresAt: Date.now() - 1 }),
      { ok: false, code: "DISPATCH_UNAVAILABLE" });
    assert.deepEqual(await page.evaluate(submitDatabagDraft, input), { ok: false, code: "DISPATCH_UNAVAILABLE" });
    assert.equal(await page.evaluate(() => window.syntheticActivations), 0);
    input = await reset();
    await page.evaluate(() => {
      const activate = HTMLElement.prototype.click;
      HTMLElement.prototype.click = function() { activate.call(this); throw new Error("Synthetic post-activation failure"); };
    });
    assert.deepEqual(await page.evaluate(submitDatabagDraft, input), { ok: false, code: "DISPATCH_UNCERTAIN" });
    assert.deepEqual(await page.evaluate(submitDatabagDraft, { ...input, expiresAt: Date.now() + 4000 }),
      { ok: false, code: "DISPATCH_UNAVAILABLE" });
    assert.equal(await page.evaluate(() => window.syntheticActivations), 1);
  } finally { await browser.close(); }
});

test("Databag guarded fills insert once and preserve human or changed-identity drafts", { timeout: 15000 }, async () => {
  const html = await readFile(new URL("../fixtures/databag.html", import.meta.url), "utf8");
  const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true, chromiumSandbox: true });
  try {
    const page = await browser.newPage();
    const expectedUrl = "https://databag.example/#/session";
    await page.route("https://databag.example/**", route => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto(expectedUrl);
    const reset = async () => {
      await page.reload();
      await page.evaluate(installDatabagAdapter, ["https://databag.example"]);
      await page.evaluate(installDraftOwnershipTracker);
      const identity = await page.evaluate(identifyDatabagConversation);
      return { expectedUrl, conversationId: identity.conversationId, text: "Synthetic Databag owned draft",
        operationId: randomUUID(), attemptId: randomUUID(), expiresAt: Date.now() + 4000 };
    };
    let input = await reset();
    assert.deepEqual(await page.evaluate(fillDatabagDraft, input), { ok: true, editor: "textarea" });
    assert.equal(await page.locator("textarea").inputValue(), input.text);
    assert.equal(await page.evaluate(() => window.syntheticTrustedInputs), 1);
    assert.equal(await page.evaluate(() => window.syntheticActivations), 0);
    assert.deepEqual(await page.evaluate(fillDatabagDraft, { ...input, expiresAt: Date.now() + 4000 }), { ok: false, code: "FILL_UNAVAILABLE" });
    assert.deepEqual(await page.evaluate(fillDatabagDraft, { ...input, attemptId: randomUUID(), expiresAt: Date.now() + 4000 }),
      { ok: false, code: "DRAFT_PRESENT" });
    const replacement = { ...input, text: "Synthetic Databag replacement", operationId: randomUUID(), attemptId: randomUUID(),
      expiresAt: Date.now() + 4000, leftover: { operationId: input.operationId, text: input.text } };
    assert.deepEqual(await page.evaluate(fillDatabagDraft, replacement), { ok: true, editor: "textarea" });
    assert.equal(await page.locator("textarea").inputValue(), replacement.text);
    await page.locator("textarea").fill(replacement.text);
    assert.deepEqual(await page.evaluate(fillDatabagDraft, { ...replacement, operationId: randomUUID(), attemptId: randomUUID(),
      expiresAt: Date.now() + 4000, leftover: { operationId: replacement.operationId, text: replacement.text } }),
    { ok: false, code: "DRAFT_PRESENT" });
    assert.equal(await page.locator("textarea").inputValue(), replacement.text);
    input = await reset();
    await page.locator("textarea").fill("Synthetic human draft");
    assert.deepEqual(await page.evaluate(fillDatabagDraft, input), { ok: false, code: "DRAFT_PRESENT" });
    assert.equal(await page.locator("textarea").inputValue(), "Synthetic human draft");
    input = await reset();
    await page.locator("textarea").evaluate(editor => editor.addEventListener("focus", () => {
      document.querySelector("[data-chat-contract]").dataset.chatChannel = "other-channel";
    }, { once: true }));
    assert.deepEqual(await page.evaluate(fillDatabagDraft, input), { ok: false, code: "TARGET_CHANGED" });
    assert.equal(await page.locator("textarea").inputValue(), "");
    assert.equal(await page.evaluate(() => window.syntheticTrustedInputs), 0);
    input = await reset();
    await page.locator("[data-chat-contract]").evaluate(root => { root.dataset.chatDraftSafe = "false"; });
    assert.deepEqual(await page.evaluate(fillDatabagDraft, input), { ok: false, code: "COMPOSER_UNAVAILABLE" });
    input = await reset();
    assert.deepEqual(await page.evaluate(fillDatabagDraft, { ...input, expiresAt: Date.now() - 1 }), { ok: false, code: "FILL_UNAVAILABLE" });
    assert.equal(await page.locator("textarea").inputValue(), "");
    assert.equal(await page.evaluate(() => window.syntheticActivations), 0);
  } finally { await browser.close(); }
});

test("Databag composer preflight is exact, attachment-free and read-only", { timeout: 15000 }, async () => {
  const html = await readFile(new URL("../fixtures/databag.html", import.meta.url), "utf8");
  const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true, chromiumSandbox: true });
  try {
    const page = await browser.newPage();
    const expectedUrl = "https://databag.example/#/session";
    await page.route("https://databag.example/**", route => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto(expectedUrl);
    const reset = async () => {
      await page.reload();
      await page.evaluate(installDatabagAdapter, ["https://databag.example"]);
      const identity = await page.evaluate(identifyDatabagConversation);
      return { expectedUrl, conversationId: identity.conversationId, text: "Synthetic Databag draft" };
    };
    let input = await reset();
    assert.equal(await page.locator("[data-chat-send]").isDisabled(), true);
    assert.deepEqual(await page.evaluate(inspectDatabagDraft, input), { ok: true, editor: "textarea" });
    assert.equal(await page.evaluate(() => window.syntheticTrustedInputs), 0);
    await page.locator("textarea").fill(input.text);
    assert.deepEqual(await page.evaluate(inspectDatabagDraft, input), { ok: false, code: "DRAFT_PRESENT" });
    assert.deepEqual(await page.evaluate(inspectDatabagDraft, { ...input, draftState: "prepared" }), { ok: true, editor: "textarea" });
    await page.locator("[data-chat-send]").evaluate(button => { button.disabled = true; });
    assert.deepEqual(await page.evaluate(inspectDatabagDraft, { ...input, draftState: "prepared" }), { ok: false, code: "SUBMIT_UNAVAILABLE" });
    assert.equal(await page.locator("textarea").inputValue(), input.text);
    for (const marker of [null, "false", "unknown"]) {
      input = await reset();
      await page.locator("[data-chat-contract]").evaluate((root, marker) => {
        if (marker === null) root.removeAttribute("data-chat-draft-safe");
        else root.dataset.chatDraftSafe = marker;
      }, marker);
      assert.deepEqual(await page.evaluate(inspectDatabagDraft, input), { ok: false, code: "COMPOSER_UNAVAILABLE" });
    }
    input = await reset();
    await page.locator("[data-chat-composer]").evaluate(region => {
      const file = document.createElement("input");
      file.type = "file";
      file.hidden = true;
      const transfer = new DataTransfer();
      transfer.items.add(new File(["Synthetic attachment"], "synthetic.txt"));
      file.files = transfer.files;
      region.append(file);
    });
    assert.deepEqual(await page.evaluate(inspectDatabagDraft, input), { ok: false, code: "DRAFT_PRESENT" });
    input = await reset();
    await page.locator("textarea").evaluate(editor => { editor.readOnly = true; });
    assert.deepEqual(await page.evaluate(inspectDatabagDraft, input), { ok: false, code: "COMPOSER_UNAVAILABLE" });
    input = await reset();
    await page.locator("[data-chat-composer]").evaluate(region => region.append(document.createElement("textarea")));
    assert.deepEqual(await page.evaluate(inspectDatabagDraft, input), { ok: false, code: "COMPOSER_UNAVAILABLE" });
    input = await reset();
    await page.locator("[data-chat-contract]").evaluate(root => { root.dataset.chatChannel = "other-channel"; });
    assert.deepEqual(await page.evaluate(inspectDatabagDraft, input), { ok: false, code: "TARGET_CHANGED" });
    input = await reset();
    assert.deepEqual(await page.evaluate(inspectDatabagDraft, { ...input, text: " draft" }), { ok: false, code: "UNSUPPORTED_MESSAGE_TEXT" });
    assert.equal(await page.locator("textarea").inputValue(), "");
    assert.equal(await page.evaluate(() => window.syntheticActivations), 0);
    assert.equal(await page.evaluate(() => window.syntheticTrustedInputs), 0);
  } finally { await browser.close(); }
});

test("Databag DOM identity binds account and channel without reading internal state", { timeout: 15000 }, async () => {
  const html = await readFile(new URL("../fixtures/databag.html", import.meta.url), "utf8");
  const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true, chromiumSandbox: true });
  try {
    const page = await browser.newPage();
    await page.route("https://databag.example/**", route => route.fulfill({ status: 200, contentType: "text/html", body: html }));
    await page.goto("https://databag.example/#/session");
    assert.equal(await page.evaluate(identifyDatabagConversation), null);
    assert.equal(await page.evaluate(installDatabagAdapter, ["https://other.example"]), false);
    assert.equal(await page.evaluate(installDatabagAdapter, ["https://databag.example"]), true);
    const baseline = await page.evaluate(identifyDatabagConversation);
    assert.match(baseline.conversationId, /^databag_[a-f0-9]{64}$/);
    assert.deepEqual(await page.evaluate(captureDatabagSnapshot, baseline.conversationId), { omittedBefore: false, messages: [
      { id: "synthetic-1", direction: "incoming", text: "Synthetic incoming message" },
      { id: "synthetic-2", direction: "outgoing", text: "Synthetic outgoing message" }
    ] });
    await page.evaluate(() => {
      window.syntheticNotifications = [];
      window.chrome = { runtime: { sendMessage: message => {
        window.syntheticNotifications.push(message);
        return Promise.resolve();
      } } };
    });
    assert.equal(await page.evaluate(observeDatabagMessages, baseline.conversationId), true);
    await page.locator("[data-chat-text]").first().evaluate(region => { region.textContent = "Synthetic revision"; });
    await page.waitForFunction(() => window.syntheticNotifications.some(message => message.kind === "chat_changed"));
    assert.equal((await page.evaluate(captureDatabagSnapshot, baseline.conversationId)).messages[0].text, "Synthetic revision");
    await page.getByRole("button", { name: "Switch channel" }).click();
    await page.waitForFunction(() => window.syntheticNotifications.some(message => message.kind === "chat_identity_changed"));
    assert.equal(await page.evaluate(() => window.syntheticNotifications.every(message =>
      Object.keys(message).length === 3 && message.provider === "databag" && /^databag_[a-f0-9]{64}$/.test(message.conversationId))), true);
    const changed = await page.evaluate(identifyDatabagConversation);
    assert.notEqual(changed.conversationId, baseline.conversationId);
    assert.equal(changed.url, baseline.url);
    assert.equal(await page.evaluate(captureDatabagSnapshot, baseline.conversationId), null);
    await page.getByRole("button", { name: "Switch account" }).click();
    assert.notEqual((await page.evaluate(identifyDatabagConversation)).conversationId, changed.conversationId);
    await page.locator("[data-chat-contract]").evaluate(root => { root.dataset.chatReady = "false"; });
    assert.equal(await page.evaluate(identifyDatabagConversation), null);
    await page.reload();
    await page.evaluate(installDatabagAdapter, ["https://databag.example"]);
    assert.equal((await page.evaluate(identifyDatabagConversation)).conversationId, baseline.conversationId);
    await page.locator("[data-chat-contract]").evaluate(root => root.removeAttribute("data-chat-channel"));
    assert.equal(await page.evaluate(identifyDatabagConversation), null);
    assert.equal(await page.evaluate(() => window.syntheticActivations), 0);
    assert.equal(await page.getByRole("textbox", { name: "Message" }).inputValue(), "");
  } finally { await browser.close(); }
});

test("Databag capture refuses unreadable rows and preserves original privacy and size bounds", { timeout: 15000 }, async () => {
  const html = await readFile(new URL("../fixtures/databag.html", import.meta.url), "utf8");
  const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true, chromiumSandbox: true });
  try {
    const page = await browser.newPage();
    await page.route("https://databag.example/**", route => route.fulfill({ status: 200, contentType: "text/html", body: html }));
    const reset = async () => {
      await page.goto("about:blank");
      await page.goto("https://databag.example/#/session");
      await page.evaluate(installDatabagAdapter, ["https://databag.example"]);
      return (await page.evaluate(identifyDatabagConversation)).conversationId;
    };
    let identity = await reset();
    await page.locator("[data-chat-message-id]").first().evaluate(row => { row.dataset.chatReadable = "false"; });
    assert.equal(await page.evaluate(captureDatabagSnapshot, identity), null);
    identity = await reset();
    await page.locator("[data-chat-message-id]").last().evaluate(row => { row.dataset.chatMessageId = "synthetic-1"; });
    assert.equal(await page.evaluate(captureDatabagSnapshot, identity), null);
    for (const style of ["display:none", "opacity:0", "visibility:hidden"]) {
      identity = await reset();
      await page.locator("[data-chat-text]").first().evaluate((region, style) => {
        region.insertAdjacentHTML("beforeend", `<span style="${style}">Synthetic hidden text</span>`);
      }, style);
      assert.equal(await page.evaluate(captureDatabagSnapshot, identity), null);
    }
    for (const markup of ["<strong>Synthetic unsupported text</strong>",
      "<svg><text>Synthetic unsupported text</text></svg>", "<math><mi>Synthetic unsupported text</mi></math>"]) {
      identity = await reset();
      await page.locator("[data-chat-text]").first().evaluate((region, markup) => region.insertAdjacentHTML("beforeend", markup), markup);
      assert.equal(await page.evaluate(captureDatabagSnapshot, identity), null);
    }
    identity = await reset();
    await page.locator("[data-chat-timeline]").evaluate(timeline => {
      const prototype = timeline.querySelector("[data-chat-message-id]").cloneNode(true);
      timeline.replaceChildren();
      for (let index = 0; index < 33; index++) {
        const row = prototype.cloneNode(true);
        row.dataset.chatMessageId = `bounded-${index}`;
        row.querySelector("[data-chat-text]").textContent = "x".repeat(16001);
        timeline.append(row);
      }
    });
    const bounded = await page.evaluate(captureDatabagSnapshot, identity);
    assert.equal(bounded.omittedBefore, true);
    assert.equal(bounded.messages.at(-1).id, "bounded-32");
    assert.equal(bounded.messages.at(-1).truncated, true);
    assert.equal(bounded.messages.at(-1).text.length, 16000);
    assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 96 * 1024);
    assert.equal(await page.evaluate(() => window.syntheticActivations), 0);
  } finally { await browser.close(); }
});

test("browser input reaches the rich editor without accepting synthetic input", async () => {
  const server = createFixtureServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  let browser;

  try {
    browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true, chromiumSandbox: true });
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
  const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true, chromiumSandbox: true });
  try {
    const page = await browser.newPage();
    await page.route("http://127.0.0.1:8787/**", (route) => route.fulfill({
      status: 200, contentType: "text/html", body: html
    }));
    await page.goto("http://127.0.0.1:8787/");
    assert.deepEqual(await page.evaluate(captureFixtureSnapshot), { omittedBefore: false, messages: [
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
      '<li data-message-id="large" data-direction="incoming"><p>' + "x".repeat(16001) + "</p></li>"));
    const long = await page.evaluate(captureFixtureSnapshot);
    assert.equal(long.messages.at(-1).text, "x".repeat(16000));
    assert.equal(long.messages.at(-1).truncated, true);
    assert.equal(long.omittedBefore, false);
    await page.locator("ol#messages").evaluate(timeline => {
      timeline.replaceChildren();
      for (let index = 0; index < 33; index++) {
        const row = document.createElement("li");
        row.dataset.messageId = `window-${index}`;
        row.dataset.direction = "incoming";
        const paragraph = document.createElement("p");
        paragraph.textContent = `Row ${index}`;
        row.append(paragraph);
        timeline.append(row);
      }
    });
    const windowed = await page.evaluate(captureFixtureSnapshot);
    assert.equal(windowed.omittedBefore, true);
    assert.equal(windowed.messages.length, 32);
    assert.equal(windowed.messages[0].id, "window-1");
    assert.equal(windowed.messages.at(-1).id, "window-32");
    await page.locator("ol#messages p").evaluateAll(paragraphs => {
      for (const paragraph of paragraphs) paragraph.textContent = "\u00e9".repeat(16000);
    });
    const byteBounded = await page.evaluate(captureFixtureSnapshot);
    assert.equal(byteBounded.omittedBefore, true);
    assert.ok(byteBounded.messages.length < 32);
    assert.equal(byteBounded.messages.at(-1).id, "window-32");
    assert.ok(Buffer.byteLength(JSON.stringify(byteBounded)) <= 96 * 1024);
    await page.locator("ol#messages").evaluate(timeline => {
      const newest = timeline.lastElementChild;
      timeline.replaceChildren(newest);
      newest.querySelector("p").textContent = "\u0000".repeat(16000);
    });
    const escaped = await page.evaluate(captureFixtureSnapshot);
    assert.equal(escaped.messages[0].truncated, undefined);
    assert.equal(escaped.messages[0].text.length, 16000);
    assert.ok(Buffer.byteLength(JSON.stringify(escaped)) <= 96 * 1024);
    await page.goto("about:blank");
    assert.equal(await page.evaluate(captureFixtureSnapshot), null);
  } finally {
    await browser.close();
  }
});

test("fixture browser evidence distinguishes a new outgoing row from existing identical text", async () => {
  const html = await readFile(new URL("../fixtures/chat.html", import.meta.url), "utf8");
  const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true, chromiumSandbox: true });
  const database = new DatabaseSync(":memory:");
  try {
    const page = await browser.newPage();
    await page.route("http://127.0.0.1:8787/**", (route) => route.fulfill({
      status: 200, contentType: "text/html; charset=utf-8", body: html
    }));
    await page.goto("http://127.0.0.1:8787/");
    const text = "Synthetic fixture evidence\nExact multiline text";
    const editor = page.getByRole("textbox", { name: "Message" });
    const send = page.getByRole("button", { name: "Send" });
    await editor.fill(text);
    await send.click();
    const before = await page.evaluate(captureFixtureSnapshot);
    assert.ok(before);
    assert.equal(before.messages[2].id, "fixture-3");
    assert.equal(before.messages[2].text, text);

    const requests = new PendingConnectionRequests();
    const owner = Symbol("synthetic fixture owner");
    const target = { origin: "http://127.0.0.1:8787", conversationId: "fixture-alpha",
      tabId: 3, documentId: "CHROME-doc_synthetic-fixture" };
    const pending = requests.create(owner, 1000);
    const grant = requests.approve(pending.requestId, target, 2000);
    assert.ok(grant);
    const ledger = new PreparedMessageOperations(requests, database);
    const prepared = ledger.prepare(owner, grant.connectionId, 1, text,
      "b66b3997-9d43-4554-8399-267d1fe9f75c", 2001);
    ledger.createRecoveryReceipt(owner, prepared.operationId, 2002);
    const [review] = ledger.listFixtureReviews(target, 2002).reviews;
    assert.ok(review);
    ledger.approveFixtureReview(target, prepared.operationId, review.reviewId, 2003);
    const [fillReview] = ledger.listFixtureFillReviews(target, 2003).reviews;
    assert.ok(fillReview);
    ledger.approveFixtureFillReview(target, prepared.operationId, fillReview.reviewId, 2003);
    const filling = ledger.requestFixtureFill(owner, prepared.operationId, 2003);
    assert.ok(filling && filling !== "busy");
    await editor.fill(text);
    assert.equal(await editor.inputValue(), text);
    assert.equal(ledger.completeFixtureFill(target, filling.attemptId, { ok: true, editor: "textarea" }, 2003), true);
    assert.equal((await filling.result).ok, true);
    const [sendReview] = ledger.listFixtureSendReviews(target, 2003).reviews;
    assert.ok(sendReview);
    ledger.approveFixtureSendReview(target, prepared.operationId, sendReview.reviewId, 2003);
    requests.publishFixtureSnapshot(target, before.messages, 2003);
    ledger.recordFixtureDispatchBaseline(owner, prepared.operationId, 2004);
    const check = ledger.requestFixtureDispatchCheck(owner, prepared.operationId, 2004);
    const inspected = await page.evaluate(inspectFixturePreflight,
      { expectedUrl: "http://127.0.0.1:8787/", text, draftState: "prepared" });
    assert.deepEqual(inspected, { ok: true, editor: "textarea" });
    assert.equal(ledger.completeFixtureDispatchCheck(target, prepared.operationId, check.checkId,
      { ok: true, editor: inspected.editor, draftText: await editor.inputValue(),
        selected: await page.evaluate(() => document.visibilityState === "visible"),
        writable: await editor.isEditable(), submitReady: await send.isEnabled() }, 2004), true);
    ledger.recordFixtureDispatchStart(owner, prepared.operationId, 2005, check.checkId);
    assert.equal(ledger.reconcileFixtureObservation(owner, prepared.operationId, 2006).state, "dispatch_uncertain");
    assert.equal(ledger.consumeFixtureDispatchAuthorization(owner, prepared.operationId, 2006)?.attemptId,
      prepared.operationId);

    await send.click();
    const after = await page.evaluate(captureFixtureSnapshot);
    assert.ok(after);
    assert.equal(after.messages.length, 4);
    requests.publishFixtureSnapshot(target, after.messages, 2010);
    assert.deepEqual(ledger.reconcileFixtureObservation(owner, prepared.operationId, 2011), {
      operationId: prepared.operationId, state: "observed_in_ui", startedAt: 2005,
      observedAt: 2010, messageId: "fixture-4"
    });
    assert.equal(await editor.inputValue(), "");
    assert.equal(database.prepare("SELECT count(*) AS count FROM message_dispatch_evidence").get().count, 1);
  } finally {
    database.close();
    await browser.close();
  }
});

test("fixture native insertText preserves multiline text and produces trusted input", async () => {
  const html = await readFile(new URL("../fixtures/chat.html", import.meta.url), "utf8");
  const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true, chromiumSandbox: true });
  try {
    const page = await browser.newPage();
    await page.route("http://127.0.0.1:8787/**", (route) => route.fulfill({
      status: 200, contentType: "text/html; charset=utf-8", body: html
    }));
    const text = "First exact line\nSecond exact line \u00e9";
    for (const kind of ["textarea", "rich"]) {
      await page.goto(`http://127.0.0.1:8787/${kind === "rich" ? "?editor=rich" : ""}`);
      const editor = page.getByRole("textbox", { name: "Message" });
      await editor.evaluate((element) => {
        window.fixtureInputProof = [];
        element.addEventListener("input", (event) => window.fixtureInputProof.push({ trusted: event.isTrusted }));
        element.focus();
      });
      assert.equal(await page.evaluate((approvedText) => document.execCommand("insertText", false, approvedText), text), true);
      assert.equal(kind === "rich" ? await editor.innerText() : await editor.inputValue(), text);
      assert.equal(await page.evaluate(() => window.fixtureInputProof.some((event) => event.trusted)), true);
      assert.equal(await page.locator("ol#messages > li").count(), 2);
      await page.getByRole("button", { name: "Send" }).click();
      assert.equal(await page.locator("ol#messages > li").count(), 3);
      assert.equal(await page.locator("ol#messages > li:last-child p").textContent(), text);
    }
  } finally {
    await browser.close();
  }
});

test("one-shot fixture draft fill preserves user input and never activates Send", async () => {
  const html = await readFile(new URL("../fixtures/chat.html", import.meta.url), "utf8");
  const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true, chromiumSandbox: true });
  try {
    const page = await browser.newPage();
    await page.route("http://127.0.0.1:8787/**", (route) => route.fulfill({
      status: 200, contentType: "text/html; charset=utf-8", body: html
    }));
    const text = "First exact line\nSecond exact line \u00e9";
    const fillInput = (expectedUrl) => ({ expectedUrl, text, expiresAt: Date.now() + 4000,
      operationId: "a66b3997-9d43-4554-8399-267d1fe9f75c", attemptId: crypto.randomUUID() });
    for (const kind of ["textarea", "rich"]) {
      const expectedUrl = `http://127.0.0.1:8787/${kind === "rich" ? "?editor=rich" : ""}`;
      await page.goto(expectedUrl);
      const editor = page.getByRole("textbox", { name: "Message" });
      await page.locator("#composer").evaluate((form) => {
        window.fixtureSubmitCount = 0;
        form.addEventListener("submit", () => { window.fixtureSubmitCount++; });
      });
      const input = fillInput(expectedUrl);
      assert.deepEqual(await page.evaluate(fillFixtureDraft, input), { ok: true, editor: kind });
      assert.equal(kind === "rich" ? await editor.innerText() : await editor.inputValue(), text);
      assert.equal(await page.locator("ol#messages > li").count(), 2);
      assert.equal(await page.evaluate(() => window.fixtureSubmitCount), 0);
      await editor.fill("");
      assert.deepEqual(await page.evaluate(fillFixtureDraft, { ...input, expiresAt: Date.now() + 4000 }),
        { ok: false, code: "FILL_UNAVAILABLE" });
      await editor.fill("User draft must remain");
      assert.deepEqual(await page.evaluate(fillFixtureDraft, fillInput(expectedUrl)), { ok: false, code: "DRAFT_PRESENT" });
      assert.equal(kind === "rich" ? await editor.innerText() : await editor.inputValue(), "User draft must remain");
      await editor.fill("");
      assert.deepEqual(await page.evaluate(fillFixtureDraft, { ...fillInput(expectedUrl), expiresAt: Date.now() - 1 }),
        { ok: false, code: "FILL_UNAVAILABLE" });
      await page.getByRole("button", { name: "Send" }).evaluate((button) => { button.disabled = true; });
      assert.deepEqual(await page.evaluate(fillFixtureDraft, fillInput(expectedUrl)), { ok: false, code: "SUBMIT_UNAVAILABLE" });
      await page.getByRole("button", { name: "Send" }).evaluate((button) => { button.disabled = false; });
      await editor.evaluate((element) => element.addEventListener("input", () => {
        if (element instanceof HTMLTextAreaElement) element.value = "";
        else element.replaceChildren();
      }, { once: true }));
      const altered = fillInput(expectedUrl);
      assert.deepEqual(await page.evaluate(fillFixtureDraft, altered), { ok: false, code: "FILL_UNCERTAIN" });
      assert.deepEqual(await page.evaluate(fillFixtureDraft, { ...altered, expiresAt: Date.now() + 4000 }),
        { ok: false, code: "FILL_UNAVAILABLE" });
      await page.goto(expectedUrl);
      await editor.evaluate((element) => element.addEventListener("focus", () => {
        document.querySelector("main").dataset.conversationId = "fixture-beta";
      }, { once: true }));
      assert.deepEqual(await page.evaluate(fillFixtureDraft, fillInput(expectedUrl)), { ok: false, code: "TARGET_CHANGED" });
      assert.equal(kind === "rich" ? await editor.innerText() : await editor.inputValue(), "");
      assert.equal(await page.locator("ol#messages > li").count(), 2);
    }
    await page.goto("about:blank");
    assert.deepEqual(await page.evaluate(fillFixtureDraft, fillInput("http://127.0.0.1:8787/")),
      { ok: false, code: "TARGET_CHANGED" });
  } finally {
    await browser.close();
  }
});

test("draft ownership requires a known fill and rejects retyped text or replaced editors", async () => {
  const html = await readFile(new URL("../fixtures/chat.html", import.meta.url), "utf8");
  const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true, chromiumSandbox: true });
  try {
    const page = await browser.newPage();
    await page.route("http://127.0.0.1:8787/**", route => route.fulfill({
      status: 200, contentType: "text/html; charset=utf-8", body: html
    }));
    for (const kind of ["textarea", "rich"]) {
      for (const mode of ["untouched", "blur", "foreign", "retyped", "input", "change", "changed-restored", "replaced", "root-replaced", "released", "unknown"]) {
        const expectedUrl = `http://127.0.0.1:8787/${kind === "rich" ? "?editor=rich" : ""}`;
        await page.goto(expectedUrl);
        await page.evaluate(installDraftOwnershipTracker);
        const input = { expectedUrl, text: "Owned exact draft\nSecond exact line", operationId: crypto.randomUUID(),
          attemptId: crypto.randomUUID(), expiresAt: Date.now() + 4000 };
        const editor = page.getByRole("textbox", { name: "Message" });
        if (mode === "unknown") await editor.fill(input.text);
        else assert.deepEqual(await page.evaluate(fillFixtureDraft, input), { ok: true, editor: kind });
        if (mode === "blur") await editor.evaluate(element => element.blur());
        if (mode === "retyped") { await editor.fill(""); await editor.fill(input.text); }
        if (mode === "input") await editor.evaluate(element => element.dispatchEvent(new InputEvent("input")));
        if (mode === "change") await editor.evaluate(element => element.dispatchEvent(new Event("change", { bubbles: true })));
        if (mode === "changed-restored") await editor.evaluate((element, input) => {
          if (element instanceof HTMLTextAreaElement) element.value = "Changed";
          else element.textContent = "Changed";
          if (window.agentDraftOwnership.matches(input.operationId, input.text, input.expectedUrl, element, document.querySelector("main"))) {
            throw new Error("Changed draft retained ownership");
          }
          if (element instanceof HTMLTextAreaElement) element.value = input.text;
          else element.innerText = input.text;
        }, input);
        if (mode === "replaced" || mode === "root-replaced") await editor.evaluate((element, mode) => {
          const original = mode === "root-replaced" ? document.querySelector("main") : element;
          const replacement = original.cloneNode(true);
          original.replaceWith(replacement);
          replacement.replaceWith(original);
        }, mode);
        if (mode === "released") await page.evaluate(input => window.agentDraftOwnership.release(input.operationId), input);
        const owned = await page.evaluate(({ input, mode }) => window.agentDraftOwnership.matches(
          mode === "foreign" ? crypto.randomUUID() : input.operationId, input.text, input.expectedUrl,
          document.querySelector("#composer textarea:not([hidden]), #composer [contenteditable=true]"), document.querySelector("main")
        ), { input, mode });
        assert.equal(owned, mode === "untouched" || mode === "blur", `${kind}/${mode}`);
        assert.equal(kind === "rich" ? await editor.innerText() : await editor.inputValue(), input.text);
        assert.equal(await page.locator("ol#messages > li").count(), 2);
        const replacement = { ...input, operationId: crypto.randomUUID(), attemptId: crypto.randomUUID(),
          text: "New independently requested message\nSecond new line", expiresAt: Date.now() + 4000,
          leftover: { operationId: mode === "foreign" ? crypto.randomUUID() : input.operationId, text: input.text } };
        assert.deepEqual(await page.evaluate(fillFixtureDraft, replacement), owned
          ? { ok: true, editor: kind } : { ok: false, code: "DRAFT_PRESENT" }, `${kind}/${mode} replacement`);
        assert.equal(kind === "rich" ? await editor.innerText() : await editor.inputValue(), owned ? replacement.text : input.text);
        assert.equal(await page.locator("ol#messages > li").count(), 2);
      }
    }
  } finally {
    await browser.close();
  }
});

test("fixture submit activates once only for the exact draft and rechecks after focus", async () => {
  const html = await readFile(new URL("../fixtures/chat.html", import.meta.url), "utf8");
  const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true, chromiumSandbox: true });
  try {
    const page = await browser.newPage();
    await page.route("http://127.0.0.1:8787/**", route => route.fulfill({
      status: 200, contentType: "text/html; charset=utf-8", body: html
    }));
    const text = "Synthetic exact submit\nSecond line \u00e9";
    for (const editor of ["textarea", "rich"]) {
      const expectedUrl = `http://127.0.0.1:8787/${editor === "rich" ? "?editor=rich" : ""}`;
      for (const outcome of ["exact", "lost_result", "changed", "disabled", "readonly", "blocked", "expired",
        "changed_on_focus", "target_on_focus", "replaced_on_focus", "throws_after_activation"]) {
        await page.goto(expectedUrl);
        const operationId = crypto.randomUUID();
        const input = { expectedUrl, text, operationId, attemptId: operationId, expiresAt: Date.now() + 4000 };
        assert.deepEqual(await page.evaluate(fillFixtureDraft, { ...input, attemptId: crypto.randomUUID() }),
          { ok: true, editor });
        await page.locator("#composer").evaluate(form => {
          window.fixtureSubmitCount = 0;
          form.addEventListener("submit", () => { window.fixtureSubmitCount++; });
        });
        if (outcome === "changed") await page.getByRole("textbox", { name: "Message" }).fill("Preserve changed draft");
        if (outcome === "disabled") await page.locator("button[type=submit]").evaluate(button => { button.disabled = true; });
        if (outcome === "readonly") await page.getByRole("textbox", { name: "Message" }).evaluate(element => {
          if (element instanceof HTMLTextAreaElement) element.readOnly = true;
          else element.setAttribute("aria-readonly", "true");
        });
        if (outcome === "blocked") await page.locator("button[type=submit]").evaluate(button => {
          const overlay = document.createElement("div");
          overlay.style.cssText = "position:fixed;inset:0;z-index:999999;background:white";
          document.body.append(overlay);
        });
        if (outcome.endsWith("_on_focus")) await page.locator("button[type=submit]").evaluate((button, action) => {
          button.addEventListener("focus", () => {
            if (action === "changed_on_focus") {
              const composer = document.querySelector("#composer [role=textbox], #composer textarea:not([hidden])");
              if (composer instanceof HTMLTextAreaElement) composer.value = "Changed during focus";
              else composer.textContent = "Changed during focus";
            }
            if (action === "target_on_focus") document.querySelector("main").dataset.conversationId = "fixture-beta";
            if (action === "replaced_on_focus") button.replaceWith(button.cloneNode(true));
          }, { once: true });
        }, outcome);
        if (outcome === "throws_after_activation") await page.evaluate(() => {
          const click = HTMLElement.prototype.click;
          HTMLElement.prototype.click = function () { click.call(this); throw new Error("Private synthetic failure"); };
        });
        const result = await page.evaluate(submitFixtureDraft,
          outcome === "expired" ? { ...input, expiresAt: Date.now() - 1 } : input);
        const activated = ["exact", "lost_result", "throws_after_activation"].includes(outcome);
        if (outcome !== "lost_result") assert.deepEqual(result, outcome === "throws_after_activation"
          ? { ok: false, code: "DISPATCH_UNCERTAIN" } : outcome === "exact"
            ? { ok: true, editor, activated: true } : { ok: false, code: outcome === "changed" || outcome === "changed_on_focus"
              ? "DRAFT_CHANGED" : outcome === "disabled" || outcome === "blocked" ? "SUBMIT_UNAVAILABLE"
                : outcome === "readonly" ? "COMPOSER_UNAVAILABLE" : outcome === "target_on_focus"
                  ? "TARGET_CHANGED" : "DISPATCH_UNAVAILABLE" }, `${editor}: ${outcome}`);
        assert.equal(await page.evaluate(() => window.fixtureSubmitCount), activated ? 1 : 0, `${editor}: ${outcome}`);
        assert.equal(await page.locator("ol#messages > li").count(), activated ? 3 : 2, `${editor}: ${outcome}`);
        assert.deepEqual(await page.evaluate(submitFixtureDraft, { ...input, expiresAt: Date.now() + 4000 }),
          { ok: false, code: "DISPATCH_UNAVAILABLE" }, `${editor}: replay ${outcome}`);
        assert.equal(await page.evaluate(() => window.fixtureSubmitCount), activated ? 1 : 0);
        if (activated) assert.equal(await page.locator("ol#messages > li:last-child p").textContent(), text);
      }
    }
  } finally {
    await browser.close();
  }
});

test("read-only fixture preflight protects drafts and rejects blocked or changed controls", async () => {
  const html = await readFile(new URL("../fixtures/chat.html", import.meta.url), "utf8");
  const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true, chromiumSandbox: true });
  try {
    const page = await browser.newPage();
    await page.route("http://127.0.0.1:8787/**", (route) => route.fulfill({
      status: 200, contentType: "text/html; charset=utf-8", body: html
    }));
    for (const editor of ["textarea", "rich"]) {
      const expectedUrl = `http://127.0.0.1:8787/${editor === "rich" ? "?editor=rich" : ""}`;
      await page.goto(expectedUrl);
      const input = { expectedUrl, text: "First line\nSecond line \u00e9" };
      const before = await page.evaluate(() => ({ focus: document.activeElement?.id,
        rows: document.querySelector("ol#messages").innerText, scroll: window.scrollY }));
      assert.deepEqual(await page.evaluate(inspectFixturePreflight, input), { ok: true, editor });
      assert.deepEqual(await page.evaluate(() => ({ focus: document.activeElement?.id,
        rows: document.querySelector("ol#messages").innerText, scroll: window.scrollY })), before);
      for (const text of [" ", " padded ", "CR\r\nLF", "x".repeat(2049), "\u00e9".repeat(2048)]) {
        assert.deepEqual(await page.evaluate(inspectFixturePreflight, { expectedUrl, text }),
          { ok: false, code: "UNSUPPORTED_MESSAGE_TEXT" });
      }
      const textbox = page.getByRole("textbox", { name: "Message" });
      const preparedInput = { ...input, draftState: "prepared" };
      assert.deepEqual(await page.evaluate(inspectFixturePreflight, preparedInput), { ok: false, code: "DRAFT_PRESENT" });
      for (const draftState of ["unknown", null, true]) {
        assert.deepEqual(await page.evaluate(inspectFixturePreflight, { ...input, draftState }),
          { ok: false, code: "COMPOSER_UNAVAILABLE" });
      }
      await textbox.fill(input.text);
      await textbox.evaluate((element) => element.blur());
      const filledBefore = await page.evaluate(() => ({ focus: document.activeElement?.id,
        selection: window.getSelection()?.toString(), rows: document.querySelector("ol#messages").innerText,
        scroll: window.scrollY }));
      assert.deepEqual(await page.evaluate(inspectFixturePreflight, input), { ok: false, code: "DRAFT_PRESENT" });
      assert.deepEqual(await page.evaluate(inspectFixturePreflight, { ...input, draftState: "empty" }),
        { ok: false, code: "DRAFT_PRESENT" });
      assert.deepEqual(await page.evaluate(inspectFixturePreflight, preparedInput), { ok: true, editor });
      assert.equal(editor === "rich" ? await textbox.innerText() : await textbox.inputValue(), input.text);
      assert.deepEqual(await page.evaluate(() => ({ focus: document.activeElement?.id,
        selection: window.getSelection()?.toString(), rows: document.querySelector("ol#messages").innerText,
        scroll: window.scrollY })), filledBefore);
      await page.getByRole("button", { name: "Send" }).evaluate((button) => { button.disabled = true; });
      assert.deepEqual(await page.evaluate(inspectFixturePreflight, preparedInput), { ok: false, code: "SUBMIT_UNAVAILABLE" });
      await page.getByRole("button", { name: "Send" }).evaluate((button) => { button.disabled = false; });
      await textbox.evaluate((element) => {
        if (element instanceof HTMLTextAreaElement) element.readOnly = true;
        else element.setAttribute("aria-readonly", "true");
      });
      assert.deepEqual(await page.evaluate(inspectFixturePreflight, preparedInput), { ok: false, code: "COMPOSER_UNAVAILABLE" });
      await textbox.evaluate((element) => {
        if (element instanceof HTMLTextAreaElement) element.readOnly = false;
        else element.removeAttribute("aria-readonly");
      });
      await page.evaluate(() => {
        const overlay = document.createElement("div");
        overlay.id = "prepared-overlay";
        Object.assign(overlay.style, { position: "fixed", inset: "0", zIndex: "9999", background: "white" });
        document.body.append(overlay);
      });
      assert.deepEqual(await page.evaluate(inspectFixturePreflight, preparedInput), { ok: false, code: "SUBMIT_UNAVAILABLE" });
      await page.locator("#prepared-overlay").evaluate((overlay) => overlay.remove());
      await textbox.fill(`${input.text}!`);
      assert.deepEqual(await page.evaluate(inspectFixturePreflight, preparedInput), { ok: false, code: "DRAFT_PRESENT" });
      assert.equal(editor === "rich" ? await textbox.innerText() : await textbox.inputValue(), `${input.text}!`);
      await textbox.fill("User draft");
      assert.deepEqual(await page.evaluate(inspectFixturePreflight, input), { ok: false, code: "DRAFT_PRESENT" });
      assert.equal(editor === "rich" ? await textbox.innerText() : await textbox.inputValue(), "User draft");
      await textbox.fill(" ");
      assert.deepEqual(await page.evaluate(inspectFixturePreflight, input), { ok: false, code: "DRAFT_PRESENT" });
      if (editor === "rich") {
        await textbox.evaluate((element) => element.replaceChildren(document.createTextNode("\n")));
        assert.deepEqual(await page.evaluate(inspectFixturePreflight, input), { ok: false, code: "DRAFT_PRESENT" });
        assert.equal(await textbox.textContent(), "\n");
        await textbox.evaluate((element) => {
          const line = document.createElement("div");
          line.append(document.createElement("br"));
          element.replaceChildren(line);
        });
        assert.equal(await textbox.innerText(), "\n");
        assert.deepEqual(await page.evaluate(inspectFixturePreflight, input), { ok: false, code: "DRAFT_PRESENT" });
        assert.equal(await textbox.evaluate((element) => element.innerHTML), "<div><br></div>");
        await textbox.evaluate((element) => element.replaceChildren(document.createElement("br")));
        assert.deepEqual(await page.evaluate(inspectFixturePreflight, input), { ok: true, editor });
        await textbox.evaluate((element) => element.replaceChildren());
        assert.equal(await textbox.innerText(), "");
        assert.deepEqual(await page.evaluate(inspectFixturePreflight, input), { ok: true, editor });
      }
      await textbox.fill("");
      await textbox.evaluate((element) => {
        if (element instanceof HTMLTextAreaElement) element.readOnly = true;
        else element.setAttribute("aria-readonly", "true");
      });
      assert.deepEqual(await page.evaluate(inspectFixturePreflight, input), { ok: false, code: "COMPOSER_UNAVAILABLE" });
      await textbox.evaluate((element) => {
        if (element instanceof HTMLTextAreaElement) element.readOnly = false;
        else element.removeAttribute("aria-readonly");
      });
      await page.locator("#composer").evaluate((form) => { form.inert = true; });
      assert.deepEqual(await page.evaluate(inspectFixturePreflight, input), { ok: false, code: "COMPOSER_UNAVAILABLE" });
      await page.locator("#composer").evaluate((form) => { form.inert = false; });
      await textbox.evaluate((element) => {
        const fieldset = document.createElement("fieldset");
        fieldset.id = "test-disabled-fieldset";
        fieldset.disabled = true;
        element.replaceWith(fieldset);
        fieldset.append(element);
      });
      assert.deepEqual(await page.evaluate(inspectFixturePreflight, input), { ok: false, code: "COMPOSER_UNAVAILABLE" });
      await page.locator("#test-disabled-fieldset").evaluate((fieldset) => fieldset.replaceWith(...fieldset.childNodes));
      await page.getByRole("button", { name: "Send" }).evaluate((button) => { button.disabled = true; });
      assert.deepEqual(await page.evaluate(inspectFixturePreflight, input), { ok: false, code: "SUBMIT_UNAVAILABLE" });
      await page.getByRole("button", { name: "Send" }).evaluate((button) => { button.disabled = false; });
      await page.evaluate(() => {
        const overlay = document.createElement("div");
        overlay.id = "test-overlay";
        Object.assign(overlay.style, { position: "fixed", inset: "0", zIndex: "9999", background: "white" });
        document.body.append(overlay);
      });
      assert.deepEqual(await page.evaluate(inspectFixturePreflight, input), { ok: false, code: "SUBMIT_UNAVAILABLE" });
      await page.locator("#test-overlay").evaluate((overlay) => overlay.remove());
      await textbox.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const overlay = document.createElement("div");
        overlay.id = "test-editor-overlay";
        Object.assign(overlay.style, { position: "fixed", left: `${rect.left}px`, top: `${rect.top}px`,
          width: `${rect.width}px`, height: `${rect.height}px`, zIndex: "9999", background: "white" });
        document.body.append(overlay);
      });
      assert.deepEqual(await page.evaluate(inspectFixturePreflight, input), { ok: false, code: "COMPOSER_UNAVAILABLE" });
      await page.locator("#test-editor-overlay").evaluate((overlay) => overlay.remove());
      await page.locator("#composer").evaluate((form) => {
        const editor = form.querySelector("textarea:not([hidden]), [contenteditable=true]:not([hidden])");
        form.append(editor.cloneNode(true));
      });
      assert.deepEqual(await page.evaluate(inspectFixturePreflight, input), { ok: false, code: "COMPOSER_UNAVAILABLE" });
      await page.goto(expectedUrl);
      await page.getByRole("button", { name: "Switch chat" }).click();
      assert.deepEqual(await page.evaluate(inspectFixturePreflight, input), { ok: false, code: "TARGET_CHANGED" });
      assert.deepEqual(await page.evaluate(inspectFixturePreflight, preparedInput), { ok: false, code: "TARGET_CHANGED" });
    }
    await page.goto("about:blank");
    assert.deepEqual(await page.evaluate(inspectFixturePreflight, { expectedUrl: "http://127.0.0.1:8787/", text: "Synthetic" }),
      { ok: false, code: "TARGET_CHANGED" });
  } finally {
    await browser.close();
  }
});