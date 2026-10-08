import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { captureGeminiSnapshot, fillGeminiDraft, identifyGeminiConversation, inspectGeminiDraft, inspectGeminiPromptControls, inspectGeminiSubmitControls, isEligibleGeminiUrl,
  observeGeminiIdentity, observeGeminiMessages, submitGeminiDraft }
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
    for (const scenario of ["ready", "disabled", "fieldset-disabled", "inert", "hidden", "transparent", "wrong-type", "duplicate", "outside-main", "timeline", "blocked", "aria-disabled", "stop-control"]) {
      await page.reload();
      await page.locator("[contenteditable]").evaluate((editor, text) => { editor.innerText = text; }, text);
      await page.locator("button").evaluate((button, scenario) => {
        button.disabled = false;
        button.type = "submit";
        button.removeAttribute("class");
        const form = button.parentElement;
        form.before(...form.children);
        form.remove();
        if (scenario === "disabled") button.disabled = true;
        if (scenario === "fieldset-disabled") {
          const fieldset = document.createElement("fieldset");
          fieldset.disabled = true;
          button.before(fieldset);
          fieldset.append(button);
        }
        if (scenario === "inert") button.setAttribute("inert", "");
        if (scenario === "hidden") button.hidden = true;
        if (scenario === "transparent") button.style.opacity = "0";
        if (scenario === "wrong-type") button.type = "button";
        if (scenario === "duplicate") button.parentElement.append(button.cloneNode(true));
        if (scenario === "outside-main") document.body.append(button);
        if (scenario === "timeline") document.querySelector("infinite-scroller").append(button);
        if (scenario === "aria-disabled") button.setAttribute("aria-disabled", "true");
        if (scenario === "stop-control") button.setAttribute("aria-label", "Stop response");
        if (scenario === "blocked") {
          const rect = button.getBoundingClientRect();
          const overlay = document.createElement("div");
          overlay.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;background:white;z-index:100`;
          document.body.append(overlay);
        }
      }, scenario);
      assert.deepEqual(await inspect({ expectedUrl, text, draftMode: "prepared", checkSubmit: true }),
        scenario === "ready" ? { ok: true, editor: "contenteditable" } : { ok: false, code: "SUBMIT_UNAVAILABLE" }, scenario);
    }
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

test("isolated one-shot Gemini draft fill uses native input and never activates Send", { timeout: 15000 }, async () => {
  const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true, chromiumSandbox: true });
  try {
    const page = await browser.newPage();
    const expectedUrl = "https://gemini.google.com/app/disposable-chat?hl=en";
    const text = "Synthetic exact draft\nSecond line \u00e9";
    await page.route("https://gemini.google.com/**", route => route.fulfill({ contentType: "text/html; charset=utf-8",
      body: `<!doctype html><html><head><style>
        main, infinite-scroller, user-query { display: block; }
        [contenteditable] { min-height: 80px; width: 400px; border: 1px solid black; }
      </style></head><body><main><infinite-scroller><user-query>Initial row</user-query></infinite-scroller>
        <div contenteditable="true" aria-label="Enter a prompt for Gemini"></div>
        <button type="submit" aria-label="Send message">Send</button></main><script>
        window.activations = 0; window.trustedInputs = 0; window.nativeInsertCalls = 0;
        const nativeInsert = Document.prototype.execCommand;
        Document.prototype.execCommand = function(command, showUi, value) {
          if (command === 'insertText') window.nativeInsertCalls += 1;
          return nativeInsert.call(this, command, showUi, value);
        };
        document.querySelector('button').onclick = () => { window.activations += 1; };
        document.querySelector('[contenteditable]').oninput = event => { if (event.isTrusted) window.trustedInputs += 1; };
      </script></body></html>` }));
    for (const scenario of ["ready", "existing", "readonly", "blocked", "focus-draft", "focus-target", "focus-timeline", "input-replaced", "input-ambiguous-root", "expired",
      "overlong-lease", "wrong-query", "oversized", "byte-oversized", "whitespace", "capacity"]) {
      await page.goto(expectedUrl);
      await page.locator("[contenteditable]").evaluate((editor, scenario) => {
        if (scenario === "existing") editor.innerText = "Existing user draft";
        if (scenario === "readonly") editor.setAttribute("aria-readonly", "true");
        if (scenario === "blocked") {
          const overlay = document.createElement("div");
          overlay.style.cssText = "position:fixed;inset:0;background:white;z-index:100";
          document.body.append(overlay);
        }
        if (scenario === "focus-draft") editor.onfocus = () => { editor.innerText = "Focus-created draft"; };
        if (scenario === "focus-target") editor.onfocus = () => { history.replaceState({}, "", "?hl=fr"); };
        if (scenario === "focus-timeline") editor.onfocus = () => {
          const timeline = document.querySelector("infinite-scroller");
          timeline.replaceWith(timeline.cloneNode(true));
        };
        if (scenario === "input-replaced") editor.addEventListener("input", () => { editor.replaceWith(editor.cloneNode(true)); });
        if (scenario === "input-ambiguous-root") editor.addEventListener("input", () => {
          const other = document.createElement("main");
          other.textContent = "Another visible region";
          document.body.append(other);
        });
        if (scenario === "capacity") window.geminiDraftFillAttempts = new Set(Array.from({ length: 100 }, () => crypto.randomUUID()));
      }, scenario);
      const input = { expectedUrl: scenario === "wrong-query" ? expectedUrl.replace("hl=en", "hl=fr") : expectedUrl,
        text: scenario === "oversized" ? "x".repeat(2049) : scenario === "byte-oversized" ? "\u00e9".repeat(2040) : scenario === "whitespace" ? " " : text,
        operationId: "0cc50313-0ce9-43ad-9e32-a0e3bfd15871", attemptId: "d4ad1de0-25d8-4609-aad9-0d307972c1fa",
        expiresAt: Date.now() + (scenario === "expired" ? -1 : scenario === "overlong-lease" ? 10000 : 4000) };
      const outcome = await page.evaluate(fillGeminiDraft, input);
      const expected = { ready: { ok: true, editor: "contenteditable" }, existing: { ok: false, code: "DRAFT_PRESENT" },
        readonly: { ok: false, code: "COMPOSER_UNAVAILABLE" }, blocked: { ok: false, code: "COMPOSER_UNAVAILABLE" },
        "focus-draft": { ok: false, code: "DRAFT_PRESENT" }, "focus-target": { ok: false, code: "TARGET_CHANGED" },
        "focus-timeline": { ok: false, code: "FILL_UNAVAILABLE" }, "input-replaced": { ok: false, code: "FILL_UNCERTAIN" },
        "input-ambiguous-root": { ok: false, code: "FILL_UNCERTAIN" },
        expired: { ok: false, code: "FILL_UNAVAILABLE" }, "overlong-lease": { ok: false, code: "FILL_UNAVAILABLE" },
        "wrong-query": { ok: false, code: "TARGET_CHANGED" }, oversized: { ok: false, code: "UNSUPPORTED_MESSAGE_TEXT" },
        "byte-oversized": { ok: false, code: "UNSUPPORTED_MESSAGE_TEXT" }, whitespace: { ok: false, code: "UNSUPPORTED_MESSAGE_TEXT" },
        capacity: { ok: false, code: "FILL_UNAVAILABLE" } };
      assert.deepEqual(outcome, expected[scenario], scenario);
      assert.equal(await page.evaluate(() => window.activations), 0, scenario);
      assert.equal(await page.evaluate(() => window.nativeInsertCalls), ["ready", "input-replaced", "input-ambiguous-root"].includes(scenario) ? 1 : 0, scenario);
      assert.equal(await page.evaluate(() => window.trustedInputs > 0), ["ready", "input-replaced", "input-ambiguous-root"].includes(scenario), scenario);
      const actualText = await page.locator("[contenteditable]").innerText();
      assert.equal(actualText, scenario === "existing" ? "Existing user draft" : scenario === "focus-draft" ? "Focus-created draft"
        : ["ready", "input-replaced", "input-ambiguous-root"].includes(scenario) ? text : "", scenario);
      assert.deepEqual(await page.evaluate(fillGeminiDraft, { ...input, expiresAt: Date.now() + 4000 }), { ok: false, code: "FILL_UNAVAILABLE" }, scenario);
      assert.equal(await page.evaluate(() => window.nativeInsertCalls), ["ready", "input-replaced", "input-ambiguous-root"].includes(scenario) ? 1 : 0, scenario);
      assert.equal(await page.evaluate(() => window.activations), 0, scenario);
      assert.equal(await page.locator("[contenteditable]").innerText(), actualText, scenario);
    }
  } finally {
    await browser.close();
  }
});

test("isolated Gemini submit consumes its attempt and rechecks exact draft/control after focus", { timeout: 15000 }, async () => {
  const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true, chromiumSandbox: true });
  try {
    const page = await browser.newPage();
    const expectedUrl = "https://gemini.google.com/app/disposable-chat?hl=en";
    const text = "Synthetic one-shot submit";
    await page.route("https://gemini.google.com/**", route => route.fulfill({ contentType: "text/html; charset=utf-8",
      body: `<!doctype html><html><head><style>
        main, infinite-scroller, user-query { display: block; }
        [contenteditable] { min-height: 80px; width: 400px; border: 1px solid black; }
      </style></head><body><main><infinite-scroller><user-query>Initial row</user-query></infinite-scroller>
        <div contenteditable="true" aria-label="Enter a prompt for Gemini"></div>
        <button type="submit" aria-label="Send message">Send</button></main><script>
        window.activations = 0;
        document.querySelector('button').onclick = () => {
          window.activations += 1;
          const row = document.createElement('user-query');
          row.textContent = document.querySelector('[contenteditable]').innerText;
          document.querySelector('infinite-scroller').append(row);
          document.querySelector('[contenteditable]').innerText = '';
        };
      </script></body></html>` }));
    for (const scenario of ["ready", "lost-result", "changed", "disabled", "readonly", "blocked", "duplicate", "stop-control", "focus-draft",
      "focus-target", "focus-button", "focus-timeline", "click-throws", "expired", "capacity", "overlong-lease", "wrong-query", "oversized",
      "fieldset-disabled", "inert", "transparent", "button-blocked"]) {
      await page.goto(expectedUrl);
      await page.locator("[contenteditable]").evaluate((editor, { scenario, text }) => {
        editor.innerText = scenario === "changed" ? "User changed draft" : text;
        const button = document.querySelector("button");
        if (scenario === "disabled") button.disabled = true;
        if (scenario === "fieldset-disabled") {
          const fieldset = document.createElement("fieldset");
          fieldset.disabled = true;
          button.before(fieldset);
          fieldset.append(button);
        }
        if (scenario === "inert") button.setAttribute("inert", "");
        if (scenario === "transparent") button.style.opacity = "0";
        if (scenario === "button-blocked") {
          const rect = button.getBoundingClientRect();
          const overlay = document.createElement("div");
          overlay.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;background:white;z-index:100`;
          document.body.append(overlay);
        }
        if (scenario === "readonly") editor.setAttribute("aria-readonly", "true");
        if (scenario === "blocked") {
          const overlay = document.createElement("div");
          overlay.style.cssText = "position:fixed;inset:0;background:white;z-index:100";
          document.body.append(overlay);
        }
        if (scenario === "duplicate") button.parentElement.append(button.cloneNode(true));
        if (scenario === "stop-control") button.setAttribute("aria-label", "Stop response");
        if (scenario === "focus-draft") button.onfocus = () => { editor.innerText = "Focus changed draft"; };
        if (scenario === "focus-target") button.onfocus = () => { history.replaceState({}, "", "?hl=fr"); };
        if (scenario === "focus-button") button.onfocus = () => { button.replaceWith(button.cloneNode(true)); };
        if (scenario === "focus-timeline") button.onfocus = () => {
          const timeline = document.querySelector("infinite-scroller");
          timeline.replaceWith(timeline.cloneNode(true));
        };
        if (scenario === "click-throws") {
          const click = HTMLElement.prototype.click;
          HTMLElement.prototype.click = function() { click.call(this); throw new Error("Synthetic lost activation result"); };
        }
        if (scenario === "capacity") window.geminiSubmitAttempts = new Set(Array.from({ length: 100 }, () => crypto.randomUUID()));
      }, { scenario, text });
      const input = { expectedUrl: scenario === "wrong-query" ? expectedUrl.replace("hl=en", "hl=fr") : expectedUrl,
        text: scenario === "oversized" ? "x".repeat(2049) : text,
        operationId: "df99320e-a54e-48e9-8c6d-09d8b1edbe9d", attemptId: "df99320e-a54e-48e9-8c6d-09d8b1edbe9d",
        expiresAt: Date.now() + (scenario === "expired" ? -1 : scenario === "overlong-lease" ? 10000 : 4000) };
      const outcome = await page.evaluate(submitGeminiDraft, input);
      const expected = { ready: { ok: true, editor: "contenteditable", activated: true }, changed: { ok: false, code: "DRAFT_CHANGED" },
        disabled: { ok: false, code: "SUBMIT_UNAVAILABLE" }, readonly: { ok: false, code: "COMPOSER_UNAVAILABLE" },
        blocked: { ok: false, code: "COMPOSER_UNAVAILABLE" }, duplicate: { ok: false, code: "SUBMIT_UNAVAILABLE" },
        "stop-control": { ok: false, code: "SUBMIT_UNAVAILABLE" }, "focus-draft": { ok: false, code: "DRAFT_CHANGED" },
        "focus-target": { ok: false, code: "TARGET_CHANGED" }, "focus-button": { ok: false, code: "DISPATCH_UNAVAILABLE" },
        "focus-timeline": { ok: false, code: "DISPATCH_UNAVAILABLE" }, "click-throws": { ok: false, code: "DISPATCH_UNCERTAIN" },
        expired: { ok: false, code: "DISPATCH_UNAVAILABLE" }, capacity: { ok: false, code: "DISPATCH_UNAVAILABLE" },
        "overlong-lease": { ok: false, code: "DISPATCH_UNAVAILABLE" }, "wrong-query": { ok: false, code: "TARGET_CHANGED" },
        oversized: { ok: false, code: "DISPATCH_UNAVAILABLE" }, "fieldset-disabled": { ok: false, code: "SUBMIT_UNAVAILABLE" },
        inert: { ok: false, code: "SUBMIT_UNAVAILABLE" }, transparent: { ok: false, code: "SUBMIT_UNAVAILABLE" },
        "button-blocked": { ok: false, code: "SUBMIT_UNAVAILABLE" } };
      if (scenario !== "lost-result") assert.deepEqual(outcome, expected[scenario], scenario);
      const activated = ["ready", "lost-result", "click-throws"].includes(scenario);
      assert.equal(await page.evaluate(() => window.activations), activated ? 1 : 0, scenario);
      assert.equal(await page.locator("user-query").count(), activated ? 2 : 1, scenario);
      if (activated) assert.equal(await page.locator("user-query").last().innerText(), text, scenario);
      assert.equal(await page.locator("[contenteditable]").innerText(), activated ? "" : scenario === "changed" ? "User changed draft"
        : scenario === "focus-draft" ? "Focus changed draft" : text, scenario);
      assert.deepEqual(await page.evaluate(submitGeminiDraft, { ...input, expiresAt: Date.now() + 4000 }), { ok: false, code: "DISPATCH_UNAVAILABLE" }, scenario);
      assert.equal(await page.evaluate(() => window.activations), activated ? 1 : 0, scenario);
      assert.equal(await page.locator("user-query").count(), activated ? 2 : 1, scenario);
    }
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