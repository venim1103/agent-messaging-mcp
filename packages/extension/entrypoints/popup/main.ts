import { browser } from "wxt/browser";
import { captureGeminiSnapshot, inspectGeminiMathLayout, inspectGeminiPromptControls, inspectGeminiSubmitControls, isEligibleGeminiUrl } from "../../lib/gemini-observation";
import { inspectDatabagStructure } from "../../lib/databag-observation";
import { isEligibleDatabagUrl } from "../../lib/provider-origins";

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
type ChatTab = { id: number; url: string };
type SelectedChat = ChatTab & { adapter: (typeof chatAdapters)[number]; canConnect: boolean };
type InspectionTarget = ChatTab & { documentId: string; isCurrent: () => Promise<boolean> };
type InspectionResult = { title: string; details: [string, string][]; status: string; checkBridge?: true };
type ProbeResult = { ok: true; protocolVersion: number } | { ok: false; error: string };
type PendingListResult = { ok: true; requests: { requestId: string; expiresAt: number }[] }
  | { ok: false; error: string };
type ChatAgent = { agentId: string; label: string; connectionCount: number; autonomous?: true };
type ChatAgentsResult = { ok: true; agents: ChatAgent[]; countsKnown: boolean } | { ok: false; error: string };
type ChatAgentApprovalResult = { ok: true; agentId: string; expiresAt: null } | { ok: false; error: string };
type ChatAgentRemovalResult = { ok: true; revoked: number; remainingAgents: number } | { ok: false; error: string };
type UnconfirmedDispatchesResult = { ok: true; attempts: { operationId: string; startedAt: number }[]; hasMore: boolean }
  | { ok: false; error: string };
type ChatApprovalResult = { ok: true; requestId: string; expiresAt: number }
  | { ok: false; error: string };
type ChatReviewsResult = { ok: true; reviews: { operationId: string; expiresAt: number;
  reviewId: string; preview: { target: "fixture-alpha" | "gemini"; text: string } }[]; hasMore: boolean }
  | { ok: false; error: string };
type ChatReviewApprovalResult = { ok: true; operationId: string; expiresAt: number }
  | { ok: false; error: string };

const fixtureOrigin = "http://127.0.0.1:8787";
const geminiOrigin = "https://gemini.google.com";
const inspectButton = document.querySelector<HTMLButtonElement>("#inspect");
const agentPanel = document.querySelector<HTMLElement>("#agent-panel");
const agentCount = document.querySelector<HTMLElement>("#agent-count");
const agentList = document.querySelector<HTMLOListElement>("#agent-list");
const refreshAgentsButton = document.querySelector<HTMLButtonElement>("#refresh-agents");
const disconnectChatButton = document.querySelector<HTMLButtonElement>("#disconnect-chat");
const unconfirmedPanel = document.querySelector<HTMLElement>("#unconfirmed-panel");
const unconfirmedStatus = document.querySelector<HTMLElement>("#unconfirmed-status");
const unconfirmedList = document.querySelector<HTMLOListElement>("#unconfirmed-list");
const refreshUnconfirmedButton = document.querySelector<HTMLButtonElement>("#refresh-unconfirmed");
const pendingButton = document.querySelector<HTMLButtonElement>("#view-pending");
const reviewButton = document.querySelector<HTMLButtonElement>("#view-reviews");
const fillReviewButton = document.querySelector<HTMLButtonElement>("#view-fill-reviews");
const sendReviewButton = document.querySelector<HTMLButtonElement>("#view-send-reviews");
const status = document.querySelector<HTMLElement>("#status");
const buildVersion = document.querySelector<HTMLElement>("#build-version");
const result = document.querySelector<HTMLElement>("#result");
const documentStatus = document.querySelector<HTMLElement>("#document-status");
const pendingResult = document.querySelector<HTMLElement>("#pending-result");
const pendingTarget = document.querySelector<HTMLElement>("#pending-target");
const pendingRequests = document.querySelector<HTMLOListElement>("#pending-requests");
const reviewResult = document.querySelector<HTMLElement>("#review-result");
const reviewHeading = document.querySelector<HTMLElement>("#review-heading");
const reviews = document.querySelector<HTMLOListElement>("#reviews");
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

async function inspectPage<Arguments extends unknown[], Result>(target: InspectionTarget,
  func: (...args: Arguments) => Result, args: Arguments): Promise<Awaited<Result> | null> {
  if (!await target.isCurrent()) return null;
  const [injection] = await browser.scripting.executeScript({
    target: { tabId: target.id, documentIds: [target.documentId] }, func, args
  });
  return injection?.frameId === 0 && injection.documentId === target.documentId && await target.isCurrent()
    ? injection.result ?? null : null;
}

async function inspectFixtureTab(target: InspectionTarget): Promise<InspectionResult | null> {
  const preview = await inspectPage(target, inspectFixture, []);
  if (!preview) return null;
  return { title: `${fixtureOrigin} / ${preview.conversationId}`,
    details: preview.messages.map(message => [message.direction, message.text]),
    status: `${preview.messages.length} rendered messages found. Checking local bridge...`, checkBridge: true };
}

async function inspectGeminiTab(target: InspectionTarget): Promise<InspectionResult | null> {
  const preview = await inspectPage(target, inspectGeminiStructure, []);
  if (!preview) return null;
  let readShape: { direction: string; characters: number }[] | null = null;
  let submitShape: ReturnType<typeof inspectGeminiSubmitControls> = null;
  let promptShape: ReturnType<typeof inspectGeminiPromptControls> = null;
  let mathShape: ReturnType<typeof inspectGeminiMathLayout> = null;
  if (preview.mainRegions === 1 && preview.timelineCount === 1) {
    submitShape = await inspectPage(target, inspectGeminiSubmitControls, [target.url]);
    promptShape = await inspectPage(target, inspectGeminiPromptControls, [target.url]);
    const captured = await inspectPage(target, captureGeminiSnapshot, []);
    if (captured) readShape = captured.messages.slice(-4).map(message => ({
      direction: message.direction, characters: message.text.length
    }));
    mathShape = await inspectPage(target, inspectGeminiMathLayout, [target.url]);
  }
  const selectedUrl = new URL(target.url);
  const selectedRoute = selectedUrl.pathname.split("/").filter(Boolean);
  const approvalRouteIssues = [
    selectedUrl.href.length > 512 ? "URL too long" : null,
    selectedUrl.username || selectedUrl.password ? "embedded credentials unsupported" : null,
    selectedUrl.hash ? "fragment present" : null,
    selectedRoute.length !== 2 ? "not a saved-chat route" : null,
    selectedRoute.some(segment => !/^[A-Za-z0-9_-]{1,128}$/.test(segment)) ? "route shape unsupported" : null
  ].filter((issue): issue is string => issue !== null);
  const details: [string, string][] = [
    ["Route", `${preview.routeDepth} path segments (values omitted)`],
    ["Approval route", approvalRouteIssues.length ? approvalRouteIssues.join(", ")
      : selectedUrl.search ? "Eligible saved-chat URL (query bound exactly)" : "Eligible saved-chat URL"],
    ["Regions", `${preview.mainRegions} main, ${preview.timelineCount} candidate chat timelines`],
    ["Editors", preview.editors.map(editor => `${editor.tag}: ${editor.isPrompt ? "Prompt" : "Other editor"}`).join("\n") || "None visible"],
    ["Send controls", submitShape ? submitShape.controls.map(control =>
      `${control.label}; ${control.classMatch ? "send-button" : "no class match"}; ${control.type}; ${control.visible ? "visible" : "hidden"}; `
      + `${control.disabled ? "disabled" : "enabled"}; ${control.ariaDisabled ? "aria-disabled" : "no aria-disabled"}; `
      + `${control.inTimeline ? "inside timeline" : "outside timeline"}; ${control.inMain ? "inside main" : "outside main"}; `
      + `${control.sharesEditorForm ? "shared editor form" : "no shared editor form"}`)
      .concat(submitShape.hasMore ? ["Additional matches omitted"] : []).join("\n") || "None matching" : "Unsupported or changed"],
    ["Prompt state", promptShape ? `${promptShape.promptCount} prompt matches; `
      + `${promptShape.empty === null ? "ambiguous" : promptShape.empty ? "empty" : "nonempty"}` : "Unsupported or changed"],
    ["Nearby prompt controls", promptShape ? promptShape.controls.map(control =>
      `depth ${promptShape.ancestorDepth}; ${control.tag}; ${control.roleButton ? "role button" : "native control"}; `
      + `${control.label}; ${control.type}; ${control.visible ? "visible" : "hidden"}; `
      + `${control.disabled ? "disabled" : "enabled"}; ${control.ariaDisabled ? "aria-disabled" : "no aria-disabled"}; `
      + `${control.sendIcon ? "send icon" : "no send icon"}`)
      .concat(promptShape.hasMore ? ["Additional matches omitted"] : []).join("\n") || "None within bounded ancestors" : "Unsupported or changed"],
    ["Rendered rows", preview.timelineCount === 1
      ? preview.rows.map(row => `${row.tag} (${row.characters} chars)`).join("\n") || "No visible rows"
      : "Missing or ambiguous chat region; no text inspected"],
    ["Read shape", readShape?.map(row => `${row.direction} (${row.characters} chars)`).join("\n")
      || "Unsupported or changed; no connection approved"],
    ["Math layout", mathShape ? [
      `${mathShape.visitedNodes} visited nodes; ${mathShape.limited ? "limit reached" : "within limits"}`,
      `katex ${mathShape.counts.katex}; visual ${mathShape.counts.visuals}; roots ${mathShape.counts.roots}; `
        + `SVG ${mathShape.counts.svgs}; images ${mathShape.counts.images}`,
      ...mathShape.roots.flatMap((root, index) => [
        `Root ${index + 1}${root.limited ? " (limited)" : ""}`,
        ...root.nodes.map(node => `depth ${node.depth}; ${node.kind}; children ${node.children}; display ${node.display}; `
          + `relative ${node.positioned}; strut ${node.strut}; offset ${node.offset}; hidden ${node.hidden}; `
          + `nontransparent ${node.nontransparent}`)
      ])
    ].join("\n") : "Unsupported or changed"]
  ];
  const grantStatusKey = `gemini-grant-status-${target.id}`;
  const grantStatus = (await browser.storage.session.get(grantStatusKey))[grantStatusKey] as
    { code?: unknown; recordedAt?: unknown } | undefined;
  if (grantStatus && typeof grantStatus.recordedAt === "number" && Number.isSafeInteger(grantStatus.recordedAt)
    && Date.now() - grantStatus.recordedAt >= 0 && Date.now() - grantStatus.recordedAt < 5 * 60_000) {
    if (grantStatus.code === "target_changed") details.push(["Last read-only grant", "Target or document changed/unavailable"]);
    if (grantStatus.code === "observation_unavailable") details.push(["Last read-only grant", "Observation unavailable; grant revoked"]);
  }
  return { title: "Chat structure (diagnostic)", details,
    status: "Structure and lengths only. No message text returned, drafts, connection, or sending." };
}

async function inspectDatabagTab(target: InspectionTarget): Promise<InspectionResult | null> {
  const shape = await inspectPage(target, inspectDatabagStructure, [{ expectedUrl: target.url, origin: new URL(target.url).origin }]);
  if (!shape) return null;
  const counts = shape.counts;
  return { title: "Chat structure (diagnostic)", details: [
    ["Bounds", `${shape.visitedElements} visited elements; ${shape.limited ? "limit reached" : "within limits"}`],
    ["Regions", `${counts.conversationRegions} conversation candidates; ${counts.timelines} timeline candidates`],
    ["Selection and account", `${counts.focusedRows} focused row candidates; ${counts.accountRegions} account regions; ${counts.accountHandles} handle regions`],
    ["Rendered structure", `${counts.messageRows} row candidates; ${counts.messageTexts} text-region candidates`],
    ["Composer", `${counts.composers} composer candidates; ${counts.fileInputs} file inputs; ${counts.stagedAssetChildren} staged elements`],
    ["Editors", `${counts.editorCandidates} candidates; ` + (shape.editors.map(editor =>
      `${editor.disabled ? "disabled" : "enabled"}; ${editor.readOnly ? "read-only" : "writable"}`).join("\n") || "None visible")],
    ["Send controls", `${counts.sendButtons} candidates; ` + (shape.sends.map(send =>
      `${send.disabled ? "disabled" : "enabled"}; ${send.ariaDisabled ? "aria-disabled" : "no aria-disabled"}`).join("\n") || "None visible")],
    ["Contract markers", shape.markerContractPresent ? "Experimental markers present" : "No experimental contract marker"]
  ], status: "Layout metadata only. No message or draft text read, connection approval, or input actions." };
}

if (!inspectButton || !agentPanel || !agentCount || !agentList || !refreshAgentsButton || !disconnectChatButton
  || !unconfirmedPanel || !unconfirmedStatus || !unconfirmedList || !refreshUnconfirmedButton
  || !pendingButton || !reviewButton || !fillReviewButton || !sendReviewButton
  || !status || !buildVersion || !result || !documentStatus || !pendingResult
  || !pendingTarget || !pendingRequests || !reviewResult || !reviewHeading || !reviews || !conversation || !messages) {
  throw new Error("Chat popup UI is incomplete");
}

buildVersion.textContent = `Build ${browser.runtime.getManifest().version_name ?? "unversioned"}`;

let selectedChat: SelectedChat | null = null;
let reviewExpiry: ReturnType<typeof setTimeout> | undefined;
let reviewRevision = 0;
let agentRosterGeneration = 0;
let unconfirmedGeneration = 0;
let inspectionRevision = 0;
let inspectionTabId: number | null = null;

function clearInspection() {
  inspectionRevision++;
  inspectionTabId = null;
  if (result) result.hidden = true;
  if (documentStatus) documentStatus.hidden = true;
  messages?.replaceChildren();
}

function clearChatAgents() {
  agentRosterGeneration++;
  unconfirmedGeneration++;
  unconfirmedList?.replaceChildren();
  if (unconfirmedStatus) unconfirmedStatus.textContent = "Unavailable";
  if (refreshUnconfirmedButton) refreshUnconfirmedButton.disabled = false;
  agentList?.replaceChildren();
  if (agentCount) agentCount.textContent = "Unavailable";
  if (disconnectChatButton) disconnectChatButton.disabled = true;
}

async function refreshUnconfirmedDispatches(): Promise<void> {
  const selected = selectedChat;
  if (!selected || !unconfirmedList || !unconfirmedStatus || !refreshUnconfirmedButton || !status) return;
  const generation = ++unconfirmedGeneration;
  refreshUnconfirmedButton.disabled = true;
  unconfirmedList.replaceChildren();
  unconfirmedStatus.textContent = "Checking...";
  try {
    const response = await browser.runtime.sendMessage({ kind: "list_unconfirmed_dispatches", tabId: selected.id,
      expectedUrl: selected.url }) as UnconfirmedDispatchesResult;
    if (generation !== unconfirmedGeneration) return;
    if (!response?.ok) { unconfirmedStatus.textContent = "Unavailable"; return; }
    unconfirmedStatus.textContent = response.attempts.length ? "Sending paused" : "Nothing to resolve";
    for (const attempt of response.attempts) {
      const row = document.createElement("li");
      row.dataset.operationId = attempt.operationId;
      const identity = document.createElement("p");
      identity.className = "agent-instance";
      identity.textContent = attempt.operationId;
      const timestamp = document.createElement("time");
      timestamp.dateTime = new Date(attempt.startedAt).toISOString();
      timestamp.textContent = new Date(attempt.startedAt).toLocaleString();
      row.append(timestamp, identity);
      const buttons: HTMLButtonElement[] = [];
      for (const outcome of ["sent", "not_sent"] as const) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = outcome === "sent" ? "Sent" : "Not sent";
        button.addEventListener("click", async () => {
          if (generation !== unconfirmedGeneration) return;
          for (const control of buttons) control.disabled = true;
          try {
            const resolution = await browser.runtime.sendMessage({ kind: "resolve_unconfirmed_dispatch", tabId: selected.id,
              expectedUrl: selected.url, operationId: attempt.operationId, outcome }) as { ok: boolean; error?: string };
            if (generation !== unconfirmedGeneration) return;
            status.textContent = resolution?.ok ? "Outcome recorded. Nothing was resent."
              : resolution?.error ?? "Resolution status unavailable; refresh.";
            await refreshUnconfirmedDispatches();
          } catch {
            if (generation === unconfirmedGeneration) status.textContent = "Resolution status unavailable; refresh.";
          }
        });
        buttons.push(button);
        row.append(button);
      }
      unconfirmedList.append(row);
    }
    if (response.hasMore) {
      const remaining = document.createElement("li");
      remaining.textContent = "More unconfirmed sends remain.";
      unconfirmedList.append(remaining);
    }
  } catch {
    if (generation === unconfirmedGeneration) unconfirmedStatus.textContent = "Unavailable";
  } finally {
    if (generation === unconfirmedGeneration) refreshUnconfirmedButton.disabled = false;
  }
}

refreshUnconfirmedButton.addEventListener("click", () => { void refreshUnconfirmedDispatches(); });

async function refreshChatAgents(): Promise<void> {
  const selected = selectedChat;
  if (!selected || !agentPanel || !agentCount || !agentList || !refreshAgentsButton || !disconnectChatButton || !status) return;
  const generation = ++agentRosterGeneration;
  refreshAgentsButton.disabled = true;
  disconnectChatButton.disabled = true;
  agentList.replaceChildren();
  agentCount.textContent = "Checking...";
  try {
    const response = await browser.runtime.sendMessage({ kind: "list_chat_agents", tabId: selected.id,
      expectedUrl: selected.url }) as ChatAgentsResult;
    if (generation !== agentRosterGeneration) return;
    if (!response?.ok) {
      agentCount.textContent = "Unavailable";
      return;
    }
    const connected = response.agents.filter(agent => agent.connectionCount > 0).length;
    agentCount.textContent = response.countsKnown ? `${connected} connected / ${response.agents.length} available`
      : `${response.agents.length} agents available; chat status unavailable`;
    disconnectChatButton.disabled = connected === 0;
    for (const agent of response.agents) {
      const row = document.createElement("li");
      row.dataset.agentId = agent.agentId;
      const label = document.createElement("strong");
      label.textContent = agent.label;
      label.title = "Client display label, not a verified model identity";
      const identity = document.createElement("p");
      identity.className = "agent-instance";
      identity.textContent = agent.agentId;
      const state = document.createElement("p");
      state.textContent = agent.autonomous ? "Autonomous access" : agent.connectionCount ? "Supervised connection" : "Not connected";
      row.append(label, identity, state);
      if (!agent.autonomous) {
        const connect = document.createElement("button");
        connect.type = "button";
        connect.className = "agent-connect";
        connect.textContent = "Connect this chat";
        connect.addEventListener("click", async () => {
          connect.disabled = true;
          try {
            const allowed = await browser.permissions.request({ origins: [`${new URL(selected.url).origin}/*`] });
            if (!allowed) { status.textContent = "Site access denied; no connection created."; return; }
            const approval = await browser.runtime.sendMessage({ kind: "approve_chat_agent", tabId: selected.id,
              expectedUrl: selected.url, agentId: agent.agentId }) as ChatAgentApprovalResult;
            status.textContent = approval?.ok ? "Agent connected."
              : approval?.error ?? "Connection unavailable; refresh status.";
          } catch {
            status.textContent = "Connection unavailable; refresh status.";
          } finally {
            connect.disabled = false;
            await refreshChatAgents();
          }
        });
        row.append(connect);
      }
      if (agent.connectionCount > 0) {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "Remove access";
        remove.addEventListener("click", async () => {
          remove.disabled = true;
          try {
            const removal = await browser.runtime.sendMessage({ kind: "remove_chat_agent", tabId: selected.id,
              expectedUrl: selected.url, agentId: agent.agentId }) as ChatAgentRemovalResult;
            if (!removal?.ok) {
              status.textContent = removal?.error ?? "Agent removal unavailable; refresh status.";
              return;
            }
            status.textContent = removal.revoked > 0 ? "Agent access removed." : "No active access remains for this agent.";
            await refreshChatAgents();
          } catch {
            status.textContent = "Agent removal unavailable; refresh status.";
          } finally {
            remove.disabled = false;
          }
        });
        row.append(remove);
      }
      agentList.append(row);
    }
  } catch {
    if (generation === agentRosterGeneration) agentCount.textContent = "Unavailable";
  } finally {
    refreshAgentsButton.disabled = false;
  }
}

refreshAgentsButton.addEventListener("click", () => { void refreshChatAgents(); });
disconnectChatButton.addEventListener("click", async () => {
  const selected = selectedChat;
  if (!selected) return;
  disconnectChatButton.disabled = true;
  try {
    const response = await browser.runtime.sendMessage({ kind: "disconnect_chat", tabId: selected.id,
      expectedUrl: selected.url }) as ChatAgentRemovalResult;
    status.textContent = response?.ok ? "Chat disconnected." : response?.error ?? "Disconnect unavailable; refresh status.";
  } catch {
    status.textContent = "Disconnect unavailable; refresh status.";
  } finally {
    await refreshChatAgents();
  }
});

function clearReviews() {
  reviewRevision++;
  if (!reviewResult || !reviews) return;
  reviewResult.hidden = true;
  reviews.replaceChildren();
  clearTimeout(reviewExpiry);
}

browser.storage.onChanged.addListener((changes, areaName) => {
  const selected = selectedChat;
  if (areaName === "session" && selected
    && Object.hasOwn(changes, `${selected.adapter.provider}-grant-${selected.id}`)) {
    clearReviews();
    clearChatAgents();
    void refreshChatAgents();
    status.textContent = "Chat approval changed. Draft review cleared.";
  }
});
browser.tabs.onActivated.addListener(({ tabId }) => {
  const selected = selectedChat;
  if (inspectionTabId !== null && tabId !== inspectionTabId) clearInspection();
  if (selected && tabId !== selected.id) {
    clearReviews();
    clearChatAgents();
    status.textContent = "Selected chat changed. Draft review cleared.";
  }
});
browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  const selected = selectedChat;
  if ((selected?.id === tabId || inspectionTabId === tabId) && (changeInfo.status === "loading" || changeInfo.url)) {
    clearInspection();
  }
  if (selected?.id === tabId && (changeInfo.status === "loading" || changeInfo.url)) {
    clearReviews();
    clearChatAgents();
    status.textContent = "Chat document changed. Draft review cleared.";
  }
});

function chatForTab(tab: { id?: number; url?: string } | undefined): SelectedChat | null {
  const id = tab?.id;
  const url = tab?.url;
  if (id == null || !url) return null;
  const adapter = chatAdapters.find(candidate => candidate.matches(url));
  return adapter ? { id, url, adapter, canConnect: adapter.canConnect(url) } : null;
}

void browser.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  selectedChat = chatForTab(tab);
  const supervised = Boolean(selectedChat?.canConnect && selectedChat.adapter.supervised);
  inspectButton.hidden = false;
  pendingButton.hidden = !supervised;
  reviewButton.hidden = !supervised;
  fillReviewButton.hidden = !supervised;
  sendReviewButton.hidden = !supervised;
  pendingTarget.textContent = "Read-only target: selected chat";
  agentPanel.hidden = !selectedChat?.canConnect;
  unconfirmedPanel.hidden = agentPanel.hidden;
  if (!unconfirmedPanel.hidden) unconfirmedStatus.textContent = "Not checked";
  if (!agentPanel.hidden) void refreshChatAgents();
});

const reviewActions = {
  review: { heading: "Prepared drafts", button: "Approve draft (no send)" },
  fill: { heading: "Draft-fill consent", button: "Allow draft fill (no send)" },
  send: { heading: "Send consent", button: "Approve send" }
} as const;

const fixtureReviewCommands = {
  review: { list: "list_fixture_prepared_reviews", approve: "approve_fixture_review" },
  fill: { list: "list_fixture_fill_reviews", approve: "approve_fixture_fill_review" },
  send: { list: "list_fixture_send_reviews", approve: "approve_fixture_send_review" }
} as const;

const geminiReviewCommands = {
  review: { list: "list_gemini_prepared_reviews", approve: "approve_gemini_review" },
  fill: { list: "list_gemini_fill_reviews", approve: "approve_gemini_fill_review" },
  send: { list: "list_gemini_send_reviews", approve: "approve_gemini_send_review" }
} as const;

const chatAdapters = [
  { provider: "fixture", matches: (url: string) => new URL(url).origin === fixtureOrigin,
    canConnect: (url: string) => new URL(url).origin === fixtureOrigin,
    inspect: inspectFixtureTab,
    supervised: { target: "fixture-alpha", pending: (tab: ChatTab) => ({ kind: "list_fixture_pending", tabId: tab.id }),
      approve: "approve_fixture", reviews: fixtureReviewCommands } },
  { provider: "gemini", matches: (url: string) => new URL(url).origin === geminiOrigin, canConnect: isEligibleGeminiUrl,
    inspect: inspectGeminiTab,
    supervised: { target: "gemini", pending: (tab: ChatTab) => ({ kind: "list_gemini_pending", tabId: tab.id, expectedUrl: tab.url }),
      approve: "approve_gemini", reviews: geminiReviewCommands } },
  { provider: "databag", matches: isEligibleDatabagUrl, canConnect: isEligibleDatabagUrl,
    inspect: inspectDatabagTab, supervised: null }
] as const;

const reviewDrafts = async (purpose: keyof typeof reviewActions) => {
  const selected = selectedChat;
  const supervised = selected?.canConnect ? selected.adapter.supervised : null;
  if (!selected || !supervised) return;
  const targetLabel = supervised.target;
  const commands = { ...reviewActions[purpose], ...supervised.reviews[purpose] };
  reviewButton.disabled = true;
  fillReviewButton.disabled = true;
  sendReviewButton.disabled = true;
  clearReviews();
  const reviewGeneration = reviewRevision;
  reviewHeading.textContent = commands.heading;
  status.textContent = "Checking the selected chat draft...";
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (reviewGeneration !== reviewRevision) return;
    if (!selected || tab?.id !== selected.id || tab.url !== selected.url) {
      status.textContent = "Selected chat changed. No draft shown.";
      return;
    }
    const response = await browser.runtime.sendMessage({
      kind: commands.list,
      tabId: tab.id, expectedUrl: selected.url }) as ChatReviewsResult;
    if (reviewGeneration !== reviewRevision) return;
    if (!response.ok) {
      status.textContent = response.error;
      return;
    }
    if (response.reviews.some(review => review.preview.target !== targetLabel)) throw new Error();
    for (const review of response.reviews) {
      const row = document.createElement("li");
      const label = document.createElement("strong");
      label.textContent = review.operationId;
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
            || !row.isConnected || reviewResult.hidden || text.textContent !== review.preview.text
            || Date.now() >= review.expiresAt) {
            clearReviews();
            status.textContent = "Chat or draft changed. No approval recorded.";
            return;
          }
          const approved = await browser.runtime.sendMessage({
            kind: commands.approve,
            tabId: tab.id, expectedUrl: selected.url, operationId: review.operationId,
            reviewId: review.reviewId }) as ChatReviewApprovalResult;
          if (!approved.ok) {
            clearReviews();
            status.textContent = `${approved.error}. No message was sent.`;
            return;
          }
          row.remove();
          status.textContent = purpose === "send"
            ? `Approved chat send ${approved.operationId}. No message was sent.`
            : purpose === "fill"
            ? `Allowed chat draft fill ${approved.operationId}. Editor unchanged. No message was sent.`
            : `Approved chat draft ${approved.operationId}. No message was sent.`;
        } catch {
          clearReviews();
          status.textContent = "Chat draft approval unavailable. No message was sent.";
        } finally {
          approve.disabled = false;
        }
      });
      row.append(label, expiry, text, approve);
      reviews.append(row);
    }
    reviewResult.hidden = false;
    if (response.reviews.length) {
      reviewExpiry = setTimeout(() => {
        clearReviews();
        status.textContent = "Prepared draft expired.";
      }, Math.max(0, Math.min(...response.reviews.map((review) => review.expiresAt)) - Date.now()));
    }
    status.textContent = response.reviews.length
      ? `${response.reviews.length} prepared draft(s)${response.hasMore ? "; more pending" : ""}. Awaiting approval.`
      : "No prepared drafts for this chat document.";
  } catch {
    if (reviewGeneration === reviewRevision) status.textContent = "Chat draft review unavailable.";
  } finally {
    reviewButton.disabled = false;
    fillReviewButton.disabled = false;
    sendReviewButton.disabled = false;
  }
};
reviewButton.addEventListener("click", () => { void reviewDrafts("review"); });
fillReviewButton.addEventListener("click", () => { void reviewDrafts("fill"); });
sendReviewButton.addEventListener("click", () => { void reviewDrafts("send"); });

pendingButton.addEventListener("click", async () => {
  pendingButton.disabled = true;
  pendingResult.hidden = true;
  pendingRequests.replaceChildren();
  status.textContent = "Checking pending IDs for the selected chat...";
  const selected = selectedChat;
  const supervised = selected?.canConnect ? selected.adapter.supervised : null;
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!selected || !supervised || tab?.id !== selected.id || tab.url !== selected.url) {
      status.textContent = "Select a supported chat first.";
      return;
    }
    const response = await browser.runtime.sendMessage(supervised.pending(selected)) as PendingListResult;
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
      approve.textContent = "Approve read-only access";
      approve.addEventListener("click", async () => {
        approve.disabled = true;
        status.textContent = "Checking the selected chat and pending request...";
        try {
          const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
          if (tab?.id !== selected.id || tab.url !== selected.url
            || Date.now() >= request.expiresAt) {
            status.textContent = "Selected chat changed or request expired. No approval sent.";
            return;
          }
          const result = await browser.runtime.sendMessage({ kind: supervised.approve,
            tabId: tab.id, expectedUrl: tab.url, pendingRequestId: request.requestId }) as ChatApprovalResult;
          if (!result.ok) {
            status.textContent = `${result.error}.`;
            return;
          }
          row.remove();
          status.textContent = `Approved ${result.requestId} for the selected chat (read only). MCP reads are enabled; nothing was sent.`;
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

inspectButton.addEventListener("click", async () => {
  inspectButton.disabled = true;
  clearInspection();
  const revision = inspectionRevision;
  status.textContent = "Inspecting selected tab...";

  try {
    const [active] = await browser.tabs.query({ active: true, currentWindow: true });
    const selected = chatForTab(active);
    if (!selected) {
      status.textContent = "Open a supported chat first.";
      return;
    }
    inspectionTabId = selected.id;
    const isCurrent = async () => {
      if (revision !== inspectionRevision) return false;
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      return revision === inspectionRevision && tab?.id === selected.id && tab.url === selected.url;
    };
    if (!await isCurrent()) {
      status.textContent = "Selected chat changed. No inspection returned.";
      return;
    }
    const site = { origins: [`${new URL(selected.url).origin}/*`] };
    if (!await browser.permissions.contains(site) && !await browser.permissions.request(site)) {
      status.textContent = "Site access denied; no inspection returned.";
      return;
    }
    if (!await isCurrent()) return;
    const [binding] = await browser.scripting.executeScript({
      target: { tabId: selected.id, frameIds: [0] },
      func: (expectedUrl: string) => window.top === window && location.href === expectedUrl && document.visibilityState === "visible",
      args: [selected.url]
    });
    const documentId = binding?.documentId;
    if (binding?.frameId !== 0 || binding.result !== true || typeof documentId !== "string"
      || !/^[!-~]{1,128}$/.test(documentId) || !await isCurrent()) {
      status.textContent = "Selected document unavailable. No inspection returned.";
      return;
    }
    const inspection = await selected.adapter.inspect({ id: selected.id, url: selected.url, documentId, isCurrent });
    if (!inspection || !await isCurrent()) {
      status.textContent = "Selected chat changed or unsupported. No inspection returned.";
      return;
    }
    conversation.textContent = inspection.title;
    documentStatus.hidden = false;
    documentStatus.textContent = `Chrome document targeting matched (${documentId.length} characters). No approval sent.`;
    for (const [label, text] of inspection.details) {
      const row = document.createElement("li");
      const heading = document.createElement("strong");
      heading.textContent = label;
      const value = document.createElement("p");
      value.textContent = text;
      row.append(heading, value);
      messages.append(row);
    }
    result.hidden = false;
    status.textContent = inspection.status;
    if (inspection.checkBridge) {
      const probe = await browser.runtime.sendMessage({ kind: "probe_native_handshake" }) as ProbeResult;
      if (await isCurrent()) status.textContent = probe.ok
        ? `Native bridge ready (protocol v${probe.protocolVersion}). Nothing was sent.`
        : `Native bridge unavailable: ${probe.error}. Nothing was sent.`;
    }
  } catch {
    if (revision === inspectionRevision) status.textContent = "Chat inspection unavailable. No approval sent.";
  } finally {
    inspectButton.disabled = false;
  }
});