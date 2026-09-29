import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { captureGeminiSnapshot, identifyGeminiConversation, isEligibleGeminiUrl, observeGeminiIdentity }
  from "../../packages/extension/lib/gemini-observation.ts";

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
  const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true });
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
      window.chrome = { runtime: { sendMessage: (message) => {
        window.identityNotifications.push(message);
        return Promise.resolve();
      } } };
    });
    assert.equal(await page.evaluate(observeGeminiIdentity, "https://gemini.google.com/app/disposable-chat"), true);
    await page.evaluate(() => history.pushState({}, "", "/app/another-chat"));
    await page.locator("model-response-content p").evaluate((paragraph) => { paragraph.textContent = "Changed"; });
    await page.waitForFunction(() => window.identityNotifications.length === 1);
    assert.deepEqual(await page.evaluate(() => window.identityNotifications), [{ kind: "gemini_identity_changed" }]);
    await page.goto("https://gemini.google.com/app/disposable-chat");
    assert.deepEqual(await page.evaluate(captureGeminiSnapshot), { messages: [
      { direction: "outgoing", text: "First line\nSecond line \u00e9" },
      { direction: "incoming", text: "OK" },
      { direction: "outgoing", text: "OK" }
    ] });
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
    await page.locator("model-response-content p").evaluate((paragraph) => { paragraph.textContent = "Updated"; });
    await page.waitForFunction(() => window.identityNotifications.length === 1);
    assert.deepEqual(await page.evaluate(() => window.identityNotifications), [{ kind: "gemini_identity_changed" }]);
    await page.goto("https://gemini.google.com/app/disposable-chat#reply");
    assert.equal(await page.evaluate(identifyGeminiConversation), null);
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