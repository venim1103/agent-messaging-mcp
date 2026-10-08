import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { captureGeminiSnapshot, identifyGeminiConversation, inspectGeminiDraft, inspectGeminiPromptControls, inspectGeminiSubmitControls, isEligibleGeminiUrl,
  observeGeminiIdentity, observeGeminiMessages }
  from "../../packages/extension/lib/gemini-observation.ts";

test("read-only Gemini draft inspection refuses unsafe composers without editing or submitting", { timeout: 15000 }, async () => {
  const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true, chromiumSandbox: true });
  try {
    const page = await browser.newPage();
    const expectedUrl = "https://gemini.google.com/app/disposable-chat?hl=en";
    const text = "Synthetic exact draft\nSecond line";
    await page.route("https://gemini.google.com/**", route => route.fulfill({ contentType: "text/html; charset=utf-8",
      body: `<!doctype html><html><head><style>
        main, infinite-scroller, user-query, user-query-content { display: block; }
        [contenteditable] { display: block; min-height: 80px; width: 400px; border: 1px solid black; }
      </style></head><body><main>
        <infinite-scroller><user-query><user-query-content>Initial row</user-query-content></user-query></infinite-scroller>
        <form><div contenteditable="true" aria-label="Enter a prompt for Gemini"></div>
          <button type="button" class="send-button" aria-label="Send message" disabled>Private button text</button></form>
      </main><script>window.submits = 0; document.querySelector('form').onsubmit = event => {
        event.preventDefault(); window.submits += 1;
      }; document.querySelector('button').onclick = () => { window.submits += 1; };</script></body></html>` }));
    await page.goto(expectedUrl);
    const inspect = async (input = { expectedUrl, text }) => {
      const before = await page.evaluate(() => ({ html: document.body.innerHTML, active: document.activeElement?.outerHTML }));
      const result = await page.evaluate(inspectGeminiDraft, input);
      assert.deepEqual(await page.evaluate(() => ({ html: document.body.innerHTML, active: document.activeElement?.outerHTML })), before);
      assert.equal(await page.evaluate(() => window.submits), 0);
      return result;
    };
    assert.deepEqual(await inspect(), { ok: true, editor: "contenteditable" });
    const inspectControls = async (url = expectedUrl) => {
      const before = await page.evaluate(() => ({ html: document.body.innerHTML, active: document.activeElement?.outerHTML }));
      const result = await page.evaluate(inspectGeminiSubmitControls, url);
      assert.deepEqual(await page.evaluate(() => ({ html: document.body.innerHTML, active: document.activeElement?.outerHTML })), before);
      assert.equal(await page.evaluate(() => window.submits), 0);
      assert.equal(JSON.stringify(result).includes("Private button text"), false);
      return result;
    };
    const control = { label: "send-message", classMatch: true, type: "button", visible: true,
      disabled: true, ariaDisabled: false, inTimeline: false, inMain: true, sharesEditorForm: true };
    assert.deepEqual(await inspectControls(), { controls: [control], hasMore: false });
    const inspectNearby = async (url = expectedUrl) => {
      const before = await page.evaluate(() => ({ html: document.body.innerHTML, active: document.activeElement?.outerHTML }));
      const result = await page.evaluate(inspectGeminiPromptControls, url);
      assert.deepEqual(await page.evaluate(() => ({ html: document.body.innerHTML, active: document.activeElement?.outerHTML })), before);
      assert.equal(await page.evaluate(() => window.submits), 0);
      assert.equal(JSON.stringify(result).includes("Private"), false);
      return result;
    };
    const nearbyControl = { tag: "button", roleButton: false, label: "send-message", type: "button", visible: true,
      disabled: true, ariaDisabled: false, sendIcon: false };
    assert.deepEqual(await inspectNearby(), { promptCount: 1, empty: true, ancestorDepth: 1, controls: [nearbyControl], hasMore: false });
    assert.equal(await inspectNearby(expectedUrl.replace("hl=en", "hl=fr")), null);
    await page.locator("button").evaluate((button) => {
      button.removeAttribute("class");
      button.setAttribute("aria-label", "Private unreviewed label");
      button.disabled = false;
      const icon = document.createElement("mat-icon");
      icon.textContent = "send";
      button.append(icon);
    });
    assert.deepEqual(await inspectControls(), { controls: [], hasMore: false });
    assert.deepEqual(await inspectNearby(), { promptCount: 1, empty: true, ancestorDepth: 1,
      controls: [{ ...nearbyControl, label: "other", disabled: false, sendIcon: true }], hasMore: false });
    await page.locator("[contenteditable]").evaluate((editor) => { editor.innerText = "Private unsent draft"; });
    assert.equal((await inspectNearby()).empty, false);
    await page.locator("form").evaluate((form) => {
      for (let count = 0; count < 8; count++) {
        const control = document.createElement("div");
        control.setAttribute("role", "button");
        control.setAttribute("aria-label", "Private role label");
        control.textContent = "Private control text";
        form.append(control);
      }
    });
    const nearbyBounded = await inspectNearby();
    assert.equal(nearbyBounded.controls.length, 8);
    assert.equal(nearbyBounded.hasMore, true);
    assert.equal(nearbyBounded.controls[1].tag, "div");
    assert.equal(nearbyBounded.controls[1].roleButton, true);
    await page.locator("[contenteditable]").evaluate((editor) => editor.parentElement.append(editor.cloneNode(true)));
    assert.deepEqual(await inspectNearby(), { promptCount: 2, empty: null, ancestorDepth: null, controls: [], hasMore: false });
    await page.reload();
    await page.locator("[contenteditable]").evaluate((editor) => {
      for (let depth = 0; depth < 4; depth++) {
        const wrapper = document.createElement("div");
        editor.parentElement.insertBefore(wrapper, editor);
        wrapper.append(editor);
      }
    });
    assert.deepEqual(await inspectNearby(), { promptCount: 1, empty: true, ancestorDepth: null, controls: [], hasMore: false });
    await page.reload();
    await page.locator("button").evaluate((button) => { button.disabled = false; });
    assert.deepEqual(await inspectControls(), { controls: [{ ...control, disabled: false }], hasMore: false });
    await page.locator("button").evaluate((button) => { button.disabled = true; });
    await page.locator("button").evaluate((button) => document.body.append(button));
    assert.deepEqual(await inspectControls(), { controls: [{ ...control, inMain: false, sharesEditorForm: false }], hasMore: false });
    await page.reload();
    assert.equal(await inspectControls(expectedUrl.replace("hl=en", "hl=fr")), null);
    await page.locator("button").evaluate((button) => {
      button.setAttribute("aria-label", "Private arbitrary label");
      button.setAttribute("aria-disabled", "true");
      document.querySelector("infinite-scroller").append(button);
    });
    assert.deepEqual(await inspectControls(), { controls: [{ ...control, label: "unrecognized", ariaDisabled: true,
      inTimeline: true, sharesEditorForm: false }], hasMore: false });
    await page.locator("button").evaluate((button) => {
      for (let count = 0; count < 4; count++) button.parentElement.append(button.cloneNode(true));
    });
    const bounded = await inspectControls();
    assert.equal(bounded.controls.length, 4);
    assert.equal(bounded.hasMore, true);
    assert.equal(JSON.stringify(bounded).includes("Private arbitrary label"), false);
    await page.reload();
    assert.deepEqual(await inspect({ expectedUrl: expectedUrl.replace("hl=en", "hl=fr"), text }), { ok: false, code: "TARGET_CHANGED" });
    assert.deepEqual(await inspect({ expectedUrl, text: "x".repeat(2049) }), { ok: false, code: "UNSUPPORTED_MESSAGE_TEXT" });
    assert.deepEqual(await inspect({ expectedUrl, text: " " }), { ok: false, code: "UNSUPPORTED_MESSAGE_TEXT" });
    await page.locator("[contenteditable]").evaluate((editor, text) => { editor.innerText = text; }, text);
    assert.deepEqual(await inspect(), { ok: false, code: "DRAFT_CHANGED" });
    assert.deepEqual(await inspect({ expectedUrl, text, draftMode: "prepared" }), { ok: true, editor: "contenteditable" });
    assert.deepEqual(await inspect({ expectedUrl, text: `${text} `, draftMode: "prepared" }), { ok: false, code: "DRAFT_CHANGED" });
    for (const attribute of ["inert", "aria-hidden", "aria-disabled", "aria-readonly"]) {
      await page.reload();
      await page.locator("form").evaluate((form, attribute) => form.setAttribute(attribute, "true"), attribute);
      assert.deepEqual(await inspect(), { ok: false, code: "COMPOSER_UNAVAILABLE" });
    }
    for (const scenario of ["duplicate", "nested", "transparent", "offscreen", "overlay", "timeline"]) {
      await page.reload();
      await page.locator("[contenteditable]").evaluate((editor, scenario) => {
        if (scenario === "duplicate") editor.parentElement.append(editor.cloneNode(true));
        if (scenario === "nested") editor.innerHTML = '<span contenteditable="true"></span>';
        if (scenario === "transparent") editor.parentElement.style.opacity = "0";
        if (scenario === "offscreen") editor.style.marginTop = "2000px";
        if (scenario === "overlay") {
          const overlay = document.createElement("div");
          overlay.style.cssText = "position:fixed;inset:0;background:white;z-index:100";
          document.body.append(overlay);
        }
        if (scenario === "timeline") document.querySelector("infinite-scroller").append(editor);
      }, scenario);
      assert.deepEqual(await inspect(), { ok: false, code: "COMPOSER_UNAVAILABLE" }, scenario);
    }
    await page.goto(`${expectedUrl}#reply`);
    assert.deepEqual(await inspect({ expectedUrl: page.url(), text }), { ok: false, code: "TARGET_CHANGED" });
    assert.equal(await inspectControls(page.url()), null);
    assert.equal(await inspectNearby(page.url()), null);
  } finally {
    await browser.close();
  }
});

test("Gemini URL eligibility accepts bounded saved chats and rejects unsupported shapes", () => {
  const saved = "https://gemini.google.com/app/disposable-chat";
  assert.equal(isEligibleGeminiUrl(saved), true);
  assert.equal(isEligibleGeminiUrl(`${saved}?hl=en`), true);
  assert.equal(isEligibleGeminiUrl(`${saved}#reply`), false);
  assert.equal(isEligibleGeminiUrl(`${saved}?hl=${"x".repeat(512)}`), false);
  assert.equal(isEligibleGeminiUrl("https://gemini.google.com/app/other?hl=en"), true);
  assert.equal(isEligibleGeminiUrl("https://gemini.google.com/app?hl=en"), false);
  assert.equal(isEligibleGeminiUrl("https://example.com/app/disposable-chat?hl=en"), false);
});

test("reviewed Gemini parser captures only bounded visible message content", async () => {
  const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true, chromiumSandbox: true });
  try {
    const page = await browser.newPage();
    await page.route("https://gemini.google.com/**", (route) => route.fulfill({
      contentType: "text/html; charset=utf-8", body: `<!doctype html><html><head><meta charset="utf-8"><style>
        main, infinite-scroller, user-query, user-query-content, model-response, model-response-content { display: block; }
        [hidden] { display: none; }
      </style></head><body>
        <main><div contenteditable="true" aria-label="Enter a prompt for Gemini">Unsent private draft</div>
          <infinite-scroller>
            <user-query><user-query-content><p class="query-text-line">First line</p>
              <p class="query-text-line">Second line \u00e9</p><p>Screen-reader wording</p>
            </user-query-content><button>Copy</button></user-query>
            <model-response><model-response-content><p>OK</p></model-response-content>
              <button>Regenerate</button></model-response>
            <user-query hidden><user-query-content><p class="query-text-line">Hidden row</p></user-query-content></user-query>
            <user-query><user-query-content><p class="query-text-line">OK</p></user-query-content></user-query>
          </infinite-scroller>
        </main>
      </body></html>`
    }));
    await page.goto("https://gemini.google.com/app/disposable-chat");
    assert.deepEqual(await page.evaluate(identifyGeminiConversation), {
      conversationId: "disposable-chat", url: "https://gemini.google.com/app/disposable-chat"
    });
    await page.evaluate(() => {
      window.identityNotifications = [];
      window.messageNotifications = [];
      window.chrome = { runtime: { sendMessage: (message) => {
        if (message.kind === "gemini_identity_changed") window.identityNotifications.push(message);
        if (message.kind === "gemini_messages_changed") window.messageNotifications.push(message);
        return Promise.resolve();
      } } };
    });
    assert.equal(await page.evaluate(observeGeminiIdentity, "https://gemini.google.com/app/disposable-chat"), true);
    assert.equal(await page.evaluate(observeGeminiMessages, "https://gemini.google.com/app/disposable-chat"), true);
    await page.locator("model-response-content p").evaluate((paragraph) => { paragraph.textContent = "Another answer"; });
    await page.waitForFunction(() => window.messageNotifications.length === 1);
    assert.deepEqual(await page.evaluate(() => window.messageNotifications), [{ kind: "gemini_messages_changed" }]);
    await page.evaluate(() => history.pushState({}, "", "/app/another-chat"));
    await page.locator("model-response-content p").evaluate((paragraph) => { paragraph.textContent = "Changed"; });
    await page.waitForFunction(() => window.identityNotifications.length === 1);
    assert.deepEqual(await page.evaluate(() => window.identityNotifications), [{ kind: "gemini_identity_changed" }]);
    assert.equal((await page.evaluate(() => window.messageNotifications)).length, 1);
    await page.goto("https://gemini.google.com/app/disposable-chat");
    assert.deepEqual(await page.evaluate(captureGeminiSnapshot), { messages: [
      { direction: "outgoing", text: "First line\nSecond line \u00e9" },
      { direction: "incoming", text: "OK" },
      { direction: "outgoing", text: "OK" }
    ] });
    await page.locator("model-response-content p").evaluate((paragraph) => { paragraph.textContent = ""; });
    assert.deepEqual(await page.evaluate(captureGeminiSnapshot), { messages: [
      { direction: "outgoing", text: "First line\nSecond line \u00e9" },
      { direction: "outgoing", text: "OK" }
    ] });
    await page.locator("model-response-content p").evaluate((paragraph) => { paragraph.textContent = "OK"; });
    await page.locator("main").evaluate((main) => {
      const duplicate = main.querySelector("infinite-scroller").cloneNode(true);
      main.append(duplicate);
    });
    assert.equal(await page.evaluate(captureGeminiSnapshot), null);
    assert.equal(await page.evaluate(identifyGeminiConversation), null);
    await page.goto("https://gemini.google.com/app/disposable-chat?hl=en");
    assert.deepEqual(await page.evaluate(identifyGeminiConversation), {
      conversationId: "disposable-chat", url: "https://gemini.google.com/app/disposable-chat?hl=en"
    });
    const exactUrl = page.url();
    assert.equal((await page.evaluate(captureGeminiSnapshot, exactUrl))?.messages.length, 3);
    await page.evaluate(() => {
      window.identityNotifications = [];
      window.chrome = { runtime: { sendMessage: (message) => {
        window.identityNotifications.push(message);
        return Promise.resolve();
      } } };
    });
    assert.equal(await page.evaluate(observeGeminiIdentity,
      "https://gemini.google.com/app/disposable-chat?hl=en"), true);
    await page.evaluate(() => history.replaceState({}, "", "?hl=fr"));
    assert.equal(await page.evaluate(captureGeminiSnapshot, exactUrl), null);
    await page.locator("model-response-content p").evaluate((paragraph) => { paragraph.textContent = "Updated"; });
    await page.waitForFunction(() => window.identityNotifications.length === 1);
    assert.deepEqual(await page.evaluate(() => window.identityNotifications), [{ kind: "gemini_identity_changed" }]);
    await page.goto("https://gemini.google.com/app/disposable-chat#reply");
    assert.equal(await page.evaluate(identifyGeminiConversation), null);
    assert.equal(await page.evaluate(captureGeminiSnapshot), null);
    await page.goto("https://gemini.google.com/app/disposable-chat");
    await page.reload();
    await page.locator("model-response-content p").evaluate((paragraph) => {
      paragraph.textContent = "x".repeat(2049);
    });
    assert.equal(await page.evaluate(captureGeminiSnapshot), null);
    await page.goto("about:blank");
    assert.equal(await page.evaluate(captureGeminiSnapshot), null);
    assert.equal(await page.evaluate(identifyGeminiConversation), null);
  } finally {
    await browser.close();
  }
});