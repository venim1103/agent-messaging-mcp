import { browser } from "wxt/browser";
import { geminiDraftText } from "../../lib/approved-probe";
import { captureGeminiSnapshot, inspectGeminiPromptControls, inspectGeminiSubmitControls, isEligibleGeminiUrl } from "../../lib/gemini-observation";

type FixturePreview = {
  conversationId: string;
  messages: { id: string; direction: string; text: string }[];
};
type GeminiPreview = {
  routeDepth: number;
  mainRegions: number;
  editors: { tag: string; isPrompt: boolean }[];
  timelineCount: number;
  rows: { tag: string; characters: number }[];
};
type ProbeResult = { ok: true; protocolVersion: number } | { ok: false; error: string };
type FixtureInputResult = { ok: true; characters: number } | { ok: false; error: string };
type PendingListResult = { ok: true; requests: { requestId: string; expiresAt: number }[] }
  | { ok: false; error: string };
type FixtureApprovalResult = { ok: true; requestId: string; expiresAt: number }
  | { ok: false; error: string };
type FixtureReviewsResult = { ok: true; reviews: { operationId: string; expiresAt: number;
  reviewId: string; preview: { target: "fixture-alpha" | "gemini"; text: string } }[]; hasMore: boolean }
  | { ok: false; error: string };
type FixtureReviewApprovalResult = { ok: true; operationId: string; expiresAt: number }
  | { ok: false; error: string };

const fixtureOrigin = "http://127.0.0.1:8787";
const richFixtureUrl = `${fixtureOrigin}/?editor=rich`;
const geminiOrigin = "https://gemini.google.com";
const inspectButton = document.querySelector<HTMLButtonElement>("#inspect");
const pendingButton = document.querySelector<HTMLButtonElement>("#view-pending");
const fixtureReviewButton = document.querySelector<HTMLButtonElement>("#view-fixture-reviews");
const fixtureFillReviewButton = document.querySelector<HTMLButtonElement>("#view-fixture-fill-reviews");
const fixtureSendReviewButton = document.querySelector<HTMLButtonElement>("#view-fixture-send-reviews");
const fixtureInputButton = document.querySelector<HTMLButtonElement>("#test-fixture-input");
const geminiDraftReview = document.querySelector<HTMLElement>("#gemini-draft-review");
const geminiDraftPreview = document.querySelector<HTMLElement>("#gemini-draft-text");
const geminiDraftButton = document.querySelector<HTMLButtonElement>("#prepare-gemini-draft");
const status = document.querySelector<HTMLElement>("#status");
const result = document.querySelector<HTMLElement>("#result");
const fixtureDocumentStatus = document.querySelector<HTMLElement>("#fixture-document-status");
const pendingResult = document.querySelector<HTMLElement>("#pending-result");
const pendingTarget = document.querySelector<HTMLElement>("#pending-target");
const pendingRequests = document.querySelector<HTMLOListElement>("#pending-requests");
const fixtureReviewResult = document.querySelector<HTMLElement>("#fixture-review-result");
const fixtureReviewHeading = document.querySelector<HTMLElement>("#fixture-review-heading");
const fixtureReviews = document.querySelector<HTMLOListElement>("#fixture-reviews");
const conversation = document.querySelector<HTMLElement>("#conversation");
const messages = document.querySelector<HTMLOListElement>("#messages");

function inspectFixture(): FixturePreview | null {
  const root = document.querySelector<HTMLElement>("main[data-conversation-id]");
  const conversationId = root?.dataset.conversationId;
  if (!root || !conversationId) return null;

  return {
    conversationId,
    messages: [...root.querySelectorAll<HTMLElement>("ol[role=log] > li[data-message-id]")]
      .slice(-6)
      .map((row) => ({
        id: row.dataset.messageId ?? "",
        direction: row.dataset.direction ?? "unknown",
        text: (row.querySelector("p")?.textContent ?? "").slice(0, 4000)
      }))
  };
}

function inspectGeminiStructure(): GeminiPreview | null {
  if (location.origin !== "https://gemini.google.com") return null;

  const visible = (element: HTMLElement) => element.getClientRects().length > 0;
  const mainRegions = [...document.querySelectorAll<HTMLElement>("main, [role=main]")].filter(visible);
  const main = mainRegions[0];
  const timelines = main ? [...main.querySelectorAll<HTMLElement>("infinite-scroller")]
    .filter((scroller) => visible(scroller) && scroller.querySelector("user-query, model-response")) : [];
  const timeline = timelines.length === 1 ? timelines[0] : undefined;
  const rows = timeline ? [...timeline.querySelectorAll<HTMLElement>("user-query, model-response")]
    .filter(visible)
    .slice(-4)
    .map((row) => {
      const text = row.localName === "user-query"
        ? [...row.querySelectorAll<HTMLElement>("user-query-content p.query-text-line")]
          .filter(visible).map((line) => line.innerText).join("\n").trim()
        : row.querySelector<HTMLElement>("model-response-content")?.innerText.trim() ?? "";
      return { tag: row.localName, characters: text.length };
    }) : [];

  return {
    routeDepth: location.pathname.split("/").filter(Boolean).length,
    mainRegions: mainRegions.length,
    editors: [...document.querySelectorAll<HTMLElement>("textarea, [contenteditable=true], [role=textbox]")]
      .filter(visible)
      .slice(0, 6)
      .map((editor) => ({
        tag: editor.localName,
        isPrompt: editor.getAttribute("aria-label") === "Enter a prompt for Gemini"
      })),
    timelineCount: timelines.length,
    rows
  };
}

if (!inspectButton || !pendingButton || !fixtureReviewButton || !fixtureFillReviewButton || !fixtureSendReviewButton || !fixtureInputButton || !geminiDraftReview
  || !geminiDraftPreview || !geminiDraftButton || !status || !result || !fixtureDocumentStatus || !pendingResult
  || !pendingTarget || !pendingRequests || !fixtureReviewResult || !fixtureReviewHeading || !fixtureReviews || !conversation || !messages) {
  throw new Error("Fixture probe UI is incomplete");
}

let selectedFixtureTab: { id: number; url: string } | null = null;
let selectedGeminiTab: { id: number; url: string } | null = null;
let fixtureReviewExpiry: ReturnType<typeof setTimeout> | undefined;
let fixtureReviewGeneration = 0;

function clearFixtureReviews() {
  fixtureReviewGeneration++;
  if (!fixtureReviewResult || !fixtureReviews) return;
  fixtureReviewResult.hidden = true;
  fixtureReviews.replaceChildren();
  clearTimeout(fixtureReviewExpiry);
}

browser.storage.onChanged.addListener((changes, areaName) => {
  const selected = selectedGeminiTab ?? selectedFixtureTab;
  if (areaName === "session" && selected
    && Object.hasOwn(changes, `${selectedGeminiTab ? "gemini" : "fixture"}-grant-${selected.id}`)) {
    clearFixtureReviews();
    status.textContent = selectedGeminiTab ? "Gemini approval changed. Draft review cleared."
      : "Fixture approval changed. Draft review cleared.";
  }
});
browser.tabs.onActivated.addListener(({ tabId }) => {
  const selected = selectedGeminiTab ?? selectedFixtureTab;
  if (selected && tabId !== selected.id) {
    clearFixtureReviews();
    status.textContent = selectedGeminiTab ? "Selected Gemini changed. Draft review cleared."
      : "Selected fixture changed. Draft review cleared.";
  }
});
browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  const selected = selectedGeminiTab ?? selectedFixtureTab;
  if (selected?.id === tabId && (changeInfo.status === "loading" || changeInfo.url)) {
    clearFixtureReviews();
    status.textContent = selectedGeminiTab ? "Gemini document changed. Draft review cleared."
      : "Fixture document changed. Draft review cleared.";
  }
});

void browser.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  const url = tab?.url ? new URL(tab.url) : null;
  const selectedSavedGemini = tab?.url ? isEligibleGeminiUrl(tab.url) : false;
  pendingButton.hidden = url?.origin !== fixtureOrigin && !selectedSavedGemini;
  fixtureReviewButton.hidden = url?.origin !== fixtureOrigin && !selectedSavedGemini;
  fixtureFillReviewButton.hidden = url?.origin !== fixtureOrigin && !selectedSavedGemini;
  fixtureSendReviewButton.hidden = url?.origin !== fixtureOrigin && !selectedSavedGemini;
  if (selectedSavedGemini) {
    fixtureReviewButton.textContent = "Review Gemini drafts";
    fixtureFillReviewButton.textContent = "Review Gemini fill consent";
    fixtureSendReviewButton.textContent = "Review Gemini send consent";
  }
  if (tab?.id != null && tab.url && url?.origin === fixtureOrigin) {
    selectedFixtureTab = { id: tab.id, url: tab.url };
  }
  pendingTarget.textContent = selectedSavedGemini
    ? "Read-only target: selected Gemini conversation" : "Read-only target: local fixture / fixture-alpha";
  fixtureInputButton.hidden = tab?.url !== richFixtureUrl;
  if (tab?.id != null && tab.url && selectedSavedGemini) {
    selectedGeminiTab = { id: tab.id, url: tab.url };
    geminiDraftPreview.textContent = geminiDraftText;
    geminiDraftReview.hidden = false;
  }
});

const fixtureReviewCommands = {
  review: { heading: "Prepared fixture drafts", list: "list_fixture_prepared_reviews",
    approve: "approve_fixture_review", button: "Approve draft (no send)" },
  fill: { heading: "Fixture draft-fill consent", list: "list_fixture_fill_reviews",
    approve: "approve_fixture_fill_review", button: "Allow draft fill (no send)" },
  send: { heading: "Fixture send consent", list: "list_fixture_send_reviews",
    approve: "approve_fixture_send_review", button: "Approve fixture send" }
} as const;

const geminiReviewCommands = {
  review: { heading: "Prepared Gemini drafts", list: "list_gemini_prepared_reviews",
    approve: "approve_gemini_review", button: "Approve draft (no send)" },
  fill: { heading: "Gemini draft-fill consent", list: "list_gemini_fill_reviews",
    approve: "approve_gemini_fill_review", button: "Allow draft fill (no send)" },
  send: { heading: "Gemini send consent", list: "list_gemini_send_reviews",
    approve: "approve_gemini_send_review", button: "Approve Gemini send" }
} as const;

const reviewFixtureDrafts = async (purpose: keyof typeof fixtureReviewCommands) => {
  const gemini = selectedGeminiTab !== null;
  const selected = selectedGeminiTab ?? selectedFixtureTab;
  const targetLabel = gemini ? "gemini" : "fixture-alpha";
  const chatLabel = gemini ? "Gemini" : "fixture";
  const commands = gemini ? geminiReviewCommands[purpose] : fixtureReviewCommands[purpose];
  fixtureReviewButton.disabled = true;
  fixtureFillReviewButton.disabled = true;
  fixtureSendReviewButton.disabled = true;
  clearFixtureReviews();
  const reviewGeneration = fixtureReviewGeneration;
  fixtureReviewHeading.textContent = commands.heading;
  status.textContent = `Checking the selected ${chatLabel} draft...`;
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (reviewGeneration !== fixtureReviewGeneration) return;
    if (!selected || tab?.id !== selected.id || tab.url !== selected.url) {
      status.textContent = gemini ? "Selected Gemini changed. No draft shown." : "Selected fixture changed. No draft shown.";
      return;
    }
    const response = await browser.runtime.sendMessage({
      kind: commands.list,
      tabId: tab.id, expectedUrl: selected.url }) as FixtureReviewsResult;
    if (reviewGeneration !== fixtureReviewGeneration) return;
    if (!response.ok) {
      status.textContent = response.error;
      return;
    }
    if (response.reviews.some(review => review.preview.target !== targetLabel)) throw new Error();
    for (const review of response.reviews) {
      const row = document.createElement("li");
      const label = document.createElement("strong");
      label.textContent = `${targetLabel} / ${review.operationId}`;
      const expiry = document.createElement("p");
      expiry.textContent = `${Math.max(0, Math.ceil((review.expiresAt - Date.now()) / 1000))} seconds remaining`;
      const text = document.createElement("pre");
      text.textContent = review.preview.text;
      const approve = document.createElement("button");
      approve.type = "button";
      approve.textContent = commands.button;
      approve.addEventListener("click", async () => {
        approve.disabled = true;
        try {
          const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
          if (tab?.id !== selected.id || tab.url !== selected.url
            || !row.isConnected || fixtureReviewResult.hidden || text.textContent !== review.preview.text
            || Date.now() >= review.expiresAt) {
            clearFixtureReviews();
            status.textContent = gemini ? "Gemini or draft changed. No approval recorded."
              : "Fixture or draft changed. No approval recorded.";
            return;
          }
          const approved = await browser.runtime.sendMessage({
            kind: commands.approve,
            tabId: tab.id, expectedUrl: selected.url, operationId: review.operationId,
            reviewId: review.reviewId }) as FixtureReviewApprovalResult;
          if (!approved.ok) {
            clearFixtureReviews();
            status.textContent = `${approved.error}. No message was sent.`;
            return;
          }
          row.remove();
          status.textContent = purpose === "send"
            ? `Approved ${chatLabel} send ${approved.operationId}. No message was sent.`
            : purpose === "fill"
            ? `Allowed ${chatLabel} draft fill ${approved.operationId}. Editor unchanged. No message was sent.`
            : `Approved ${chatLabel} draft ${approved.operationId}. No message was sent.`;
        } catch {
          clearFixtureReviews();
          status.textContent = gemini ? "Gemini draft approval unavailable. No message was sent."
            : "Fixture draft approval unavailable. No message was sent.";
        } finally {
          approve.disabled = false;
        }
      });
      row.append(label, expiry, text, approve);
      fixtureReviews.append(row);
    }
    fixtureReviewResult.hidden = false;
    if (response.reviews.length) {
      fixtureReviewExpiry = setTimeout(() => {
        clearFixtureReviews();
        status.textContent = gemini ? "Prepared Gemini draft expired." : "Prepared fixture draft expired.";
      }, Math.max(0, Math.min(...response.reviews.map((review) => review.expiresAt)) - Date.now()));
    }
    status.textContent = response.reviews.length
      ? `${response.reviews.length} prepared ${chatLabel} draft(s)${response.hasMore ? "; more pending" : ""}. Awaiting approval.`
      : gemini ? "No prepared drafts for this Gemini document." : "No prepared drafts for this fixture document.";
  } catch {
    if (reviewGeneration === fixtureReviewGeneration) status.textContent = gemini ? "Gemini draft review unavailable."
      : "Fixture draft review unavailable.";
  } finally {
    fixtureReviewButton.disabled = false;
    fixtureFillReviewButton.disabled = false;
    fixtureSendReviewButton.disabled = false;
  }
};
fixtureReviewButton.addEventListener("click", () => { void reviewFixtureDrafts("review"); });
fixtureFillReviewButton.addEventListener("click", () => { void reviewFixtureDrafts("fill"); });
fixtureSendReviewButton.addEventListener("click", () => { void reviewFixtureDrafts("send"); });

pendingButton.addEventListener("click", async () => {
  pendingButton.disabled = true;
  pendingResult.hidden = true;
  pendingRequests.replaceChildren();
  status.textContent = selectedGeminiTab ? "Checking pending IDs for the selected Gemini chat..."
    : "Checking pending IDs for the local fixture...";
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    const geminiSelected = selectedGeminiTab?.id === tab?.id && selectedGeminiTab?.url === tab?.url;
    const fixtureSelected = !!tab?.url && new URL(tab.url).origin === fixtureOrigin;
    if (tab?.id == null || (!fixtureSelected && !geminiSelected)) {
      status.textContent = "Select the local fixture or saved Gemini chat first.";
      return;
    }
    const response = await browser.runtime.sendMessage(geminiSelected
      ? { kind: "list_gemini_pending", tabId: tab.id, expectedUrl: selectedGeminiTab!.url }
      : { kind: "list_fixture_pending", tabId: tab.id }) as PendingListResult;
    if (!response.ok) {
      status.textContent = response.error;
      return;
    }
    for (const request of response.requests) {
      const row = document.createElement("li");
      const label = document.createElement("strong");
      label.textContent = request.requestId;
      const expiry = document.createElement("p");
      expiry.textContent = `${Math.max(0, Math.ceil((request.expiresAt - Date.now()) / 1000))} seconds remaining`;
      const approve = document.createElement("button");
      approve.type = "button";
      approve.textContent = geminiSelected ? "Approve read-only Gemini chat" : "Approve read-only fixture";
      approve.addEventListener("click", async () => {
        approve.disabled = true;
        status.textContent = "Checking the selected chat and pending request...";
        try {
          const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
          if (tab?.id == null || !tab.url || (geminiSelected
            ? selectedGeminiTab?.id !== tab.id || selectedGeminiTab?.url !== tab.url
            : new URL(tab.url).origin !== fixtureOrigin)
            || Date.now() >= request.expiresAt) {
            status.textContent = "Selected chat changed or request expired. No approval sent.";
            return;
          }
          const result = await browser.runtime.sendMessage({ kind: geminiSelected ? "approve_gemini" : "approve_fixture",
            tabId: tab.id, expectedUrl: tab.url, pendingRequestId: request.requestId }) as FixtureApprovalResult;
          if (!result.ok) {
            status.textContent = `${result.error}.`;
            return;
          }
          row.remove();
          status.textContent = geminiSelected
            ? `Approved ${result.requestId} for the selected Gemini chat (read only). MCP reads are enabled; nothing was sent.`
            : `Approved ${result.requestId} for fixture-alpha (read only). Fixture snapshot captured for the MCP client.`;
        } catch {
          status.textContent = "Chat approval unavailable; check the selected tab.";
        } finally {
          approve.disabled = false;
        }
      });
      row.append(label, expiry, approve);
      pendingRequests.append(row);
    }
    pendingResult.hidden = false;
    status.textContent = response.requests.length
      ? `${response.requests.length} pending ID(s). Listing alone does not approve or read messages.`
      : "No pending requests. Listing alone does not approve or read messages.";
  } catch {
    status.textContent = "Pending list unavailable.";
  } finally {
    pendingButton.disabled = false;
  }
});

geminiDraftButton.addEventListener("click", async () => {
  geminiDraftButton.disabled = true;
  status.textContent = "Filling only the approved Gemini draft. Send will not be clicked...";
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!selectedGeminiTab || tab?.id !== selectedGeminiTab.id || tab.url !== selectedGeminiTab.url) {
      status.textContent = "The selected Gemini conversation changed. No draft filled.";
      return;
    }
    const probe = await browser.runtime.sendMessage({
      kind: "prepare_gemini_draft", tabId: selectedGeminiTab.id, expectedUrl: selectedGeminiTab.url
    }) as FixtureInputResult;
    status.textContent = probe.ok
      ? `Gemini draft matched (${probe.characters} characters). Send was not clicked. Review it in the chat.`
      : `${probe.error}. Send was not clicked. Review the composer before retrying.`;
  } catch {
    status.textContent = "Gemini draft probe unavailable. Inspect the composer before any retry. Send was not clicked.";
  } finally {
    geminiDraftButton.disabled = false;
  }
});

fixtureInputButton.addEventListener("click", async () => {
  fixtureInputButton.disabled = true;
  status.textContent = "Checking debugger input on the local rich fixture...";
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.id == null || tab.url !== richFixtureUrl) {
      status.textContent = "Open the local rich fixture to test input. Nothing sent.";
      return;
    }
    const probe = await browser.runtime.sendMessage({ kind: "probe_fixture_input", tabId: tab.id }) as FixtureInputResult;
    status.textContent = probe.ok
      ? `Fixture input read back (${probe.characters} characters). Send was not clicked.`
      : `${probe.error}. Send was not clicked.`;
  } catch {
    status.textContent = "Fixture debugger input unavailable. Inspect the draft before retrying.";
  } finally {
    fixtureInputButton.disabled = false;
  }
});

inspectButton.addEventListener("click", async () => {
  inspectButton.disabled = true;
  result.hidden = true;
  fixtureDocumentStatus.hidden = true;
  messages.replaceChildren();
  status.textContent = "Inspecting selected tab...";

  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.id == null || !tab.url) {
      status.textContent = "Open the fixture or a disposable Gemini chat first.";
      return;
    }

    const origin = new URL(tab.url).origin;
    if (origin === geminiOrigin) {
      const [injection] = await browser.scripting.executeScript({
        target: { tabId: tab.id },
        func: inspectGeminiStructure
      });
      const preview = injection?.result;
      if (!preview) {
        status.textContent = "Could not inspect the selected Gemini tab.";
        return;
      }

      let readShape: { direction: string; characters: number }[] | null = null;
      let submitShape: ReturnType<typeof inspectGeminiSubmitControls> = null;
      let promptShape: ReturnType<typeof inspectGeminiPromptControls> = null;
      const documentId = injection.documentId;
      if (typeof documentId === "string" && /^[!-~]{1,128}$/.test(documentId)
        && preview.mainRegions === 1 && preview.timelineCount === 1) {
        try {
          const [controls] = await browser.scripting.executeScript({
            target: { tabId: tab.id, documentIds: [documentId] }, func: inspectGeminiSubmitControls, args: [tab.url]
          });
          const [selected] = await browser.tabs.query({ active: true, currentWindow: true });
          if (controls?.frameId === 0 && controls.documentId === documentId && selected?.id === tab.id
            && (await browser.tabs.get(tab.id)).url === tab.url) submitShape = controls.result ?? null;
          const [nearby] = await browser.scripting.executeScript({
            target: { tabId: tab.id, documentIds: [documentId] }, func: inspectGeminiPromptControls, args: [tab.url]
          });
          const [current] = await browser.tabs.query({ active: true, currentWindow: true });
          if (nearby?.frameId === 0 && nearby.documentId === documentId && current?.id === tab.id
            && (await browser.tabs.get(tab.id)).url === tab.url) promptShape = nearby.result ?? null;
          const [captured] = await browser.scripting.executeScript({
            target: { tabId: tab.id, documentIds: [documentId] }, func: captureGeminiSnapshot
          });
          if (captured?.frameId === 0 && captured.documentId === documentId
            && (await browser.tabs.get(tab.id)).url === tab.url && captured.result) {
            readShape = captured.result.messages.slice(-4).map((message) => ({
              direction: message.direction, characters: message.text.length
            }));
          }
        } catch {}
      }

      conversation.textContent = "Gemini structure (diagnostic)";
      const selectedUrl = new URL(tab.url);
      const selectedRoute = selectedUrl.pathname.split("/").filter(Boolean);
      const approvalRouteIssues = [
        selectedUrl.href.length > 512 ? "URL too long" : null,
        selectedUrl.username || selectedUrl.password ? "embedded credentials unsupported" : null,
        selectedUrl.hash ? "fragment present" : null,
        selectedRoute.length !== 2 ? "not a saved-chat route" : null,
        selectedRoute.some((segment) => !/^[A-Za-z0-9_-]{1,128}$/.test(segment)) ? "route shape unsupported" : null
      ].filter((issue): issue is string => issue !== null);
      const details: [string, string][] = [
        ["Route", `${preview.routeDepth} path segments (values omitted)`],
        ["Approval route", approvalRouteIssues.length ? approvalRouteIssues.join(", ")
          : selectedUrl.search ? "Eligible saved-chat URL (query bound exactly)" : "Eligible saved-chat URL"],
        ["Regions", `${preview.mainRegions} main, ${preview.timelineCount} candidate chat timelines`],
        ["Editors", preview.editors.map((editor) => `${editor.tag}: ${editor.isPrompt ? "Gemini prompt" : "other editor"}`).join("\n") || "None visible"],
        ["Send controls", submitShape ? submitShape.controls.map((control) =>
          `${control.label}; ${control.classMatch ? "send-button" : "no class match"}; ${control.type}; ${control.visible ? "visible" : "hidden"}; `
          + `${control.disabled ? "disabled" : "enabled"}; ${control.ariaDisabled ? "aria-disabled" : "no aria-disabled"}; `
          + `${control.inTimeline ? "inside timeline" : "outside timeline"}; ${control.inMain ? "inside main" : "outside main"}; `
          + `${control.sharesEditorForm ? "shared editor form" : "no shared editor form"}`)
          .concat(submitShape.hasMore ? ["Additional matches omitted"] : []).join("\n") || "None matching"
          : "Unsupported or changed"],
        ["Prompt state", promptShape ? `${promptShape.promptCount} prompt matches; `
          + `${promptShape.empty === null ? "ambiguous" : promptShape.empty ? "empty" : "nonempty"}` : "Unsupported or changed"],
        ["Nearby prompt controls", promptShape ? promptShape.controls.map((control) =>
          `depth ${promptShape.ancestorDepth}; ${control.tag}; ${control.roleButton ? "role button" : "native control"}; `
          + `${control.label}; ${control.type}; ${control.visible ? "visible" : "hidden"}; `
          + `${control.disabled ? "disabled" : "enabled"}; ${control.ariaDisabled ? "aria-disabled" : "no aria-disabled"}; `
          + `${control.sendIcon ? "send icon" : "no send icon"}`)
          .concat(promptShape.hasMore ? ["Additional matches omitted"] : []).join("\n") || "None within bounded ancestors"
          : "Unsupported or changed"],
        ["Rendered rows", preview.timelineCount === 1
          ? preview.rows.map((row) => `${row.tag} (${row.characters} chars)`).join("\n") || "No visible rows"
          : "Missing or ambiguous chat region; no text inspected"],
        ["Read shape", readShape?.map((row) => `${row.direction} (${row.characters} chars)`).join("\n")
          || "Unsupported or changed; no connection approved"]
      ];
      const grantStatusKey = `gemini-grant-status-${tab.id}`;
      const grantStatus = (await browser.storage.session.get(grantStatusKey))[grantStatusKey] as
        { code?: unknown; recordedAt?: unknown } | undefined;
      if (grantStatus && typeof grantStatus.recordedAt === "number"
        && Number.isSafeInteger(grantStatus.recordedAt)
        && Date.now() - grantStatus.recordedAt >= 0
        && Date.now() - grantStatus.recordedAt < 5 * 60_000) {
        if (grantStatus.code === "target_changed") details.push(["Last read-only grant", "Target or document changed/unavailable"]);
        if (grantStatus.code === "observation_unavailable") details.push(["Last read-only grant", "Observation unavailable; grant revoked"]);
      }
      for (const [label, text] of details) {
        const row = document.createElement("li");
        const heading = document.createElement("strong");
        heading.textContent = label;
        const value = document.createElement("p");
        value.textContent = text;
        row.append(heading, value);
        messages.append(row);
      }
      result.hidden = false;
      status.textContent = "Structure and lengths only. No message text returned, drafts, connection, or sending.";
      return;
    }

    if (origin !== fixtureOrigin) {
      status.textContent = "Only the local fixture and gemini.google.com are supported by this probe.";
      return;
    }

    const [injection] = await browser.scripting.executeScript({
      target: { tabId: tab.id },
      func: inspectFixture
    });
    const preview = injection?.result;
    if (!preview) {
      status.textContent = "No fixture conversation found in this tab.";
      return;
    }

    conversation.textContent = `${fixtureOrigin} / ${preview.conversationId}`;
    const documentId = injection?.documentId;
    fixtureDocumentStatus.hidden = false;
    if (typeof documentId !== "string") {
      fixtureDocumentStatus.textContent = "Chrome document ID missing. No approval sent.";
    } else if (!/^[!-~]{1,128}$/.test(documentId)) {
      fixtureDocumentStatus.textContent = `Chrome document ID shape unsupported (${documentId.length} characters). No approval sent.`;
    } else {
      try {
        const [targeted] = await browser.scripting.executeScript({
          target: { tabId: tab.id, documentIds: [documentId] }, func: inspectFixture
        });
        fixtureDocumentStatus.textContent = targeted?.frameId === 0 && targeted.documentId === documentId
          && targeted.result?.conversationId === preview.conversationId
          ? `Chrome document targeting matched (${documentId.length} characters). No approval sent.`
          : "Chrome document targeting changed. No approval sent.";
      } catch {
        fixtureDocumentStatus.textContent = "Chrome document targeting unavailable. No approval sent.";
      }
    }
    for (const message of preview.messages) {
      const row = document.createElement("li");
      const direction = document.createElement("strong");
      direction.textContent = message.direction;
      const text = document.createElement("p");
      text.textContent = message.text;
      row.append(direction, text);
      messages.append(row);
    }
    result.hidden = false;
    status.textContent = `${preview.messages.length} rendered messages found. Checking local bridge...`;
    const probe = await browser.runtime.sendMessage({ kind: "probe_native_handshake" }) as ProbeResult;
    status.textContent = probe.ok
      ? `Native bridge ready (protocol v${probe.protocolVersion}). Nothing was sent.`
      : `Native bridge unavailable: ${probe.error}. Nothing was sent.`;
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "Could not inspect this tab.";
  } finally {
    inspectButton.disabled = false;
  }
});