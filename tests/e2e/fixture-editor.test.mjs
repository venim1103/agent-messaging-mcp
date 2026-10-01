import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { captureFixtureSnapshot, fillFixtureDraft, inspectFixturePreflight, observeFixtureMessages } from "../../packages/extension/lib/fixture-observation.ts";
import { PreparedMessageOperations } from "../../packages/companion/dist/message-operations.js";
import { PendingConnectionRequests } from "../../packages/companion/dist/pending-connections.js";
import { createFixtureServer } from "../fixtures/server.mjs";

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