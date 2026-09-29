export type GeminiRenderedMessage = { direction: "incoming" | "outgoing"; text: string };

export function isEligibleGeminiUrl(href: string): boolean {
  try {
    const url = new URL(href);
    const route = url.pathname.split("/").filter(Boolean);
    return url.href === href && url.origin === "https://gemini.google.com"
      && url.href.length <= 512 && !url.username && !url.password && !url.hash
      && route.length === 2 && route.every((segment) => /^[A-Za-z0-9_-]{1,128}$/.test(segment));
  } catch {
    return false;
  }
}

export function identifyGeminiConversation(): { conversationId: string; url: string } | null {
  if (location.origin !== "https://gemini.google.com") return null;
  const url = new URL(location.href);
  const route = url.pathname.split("/").filter(Boolean);
  if (url.href.length > 512 || url.username || url.password || url.hash || route.length !== 2
    || route.some((segment) => !/^[A-Za-z0-9_-]{1,128}$/.test(segment))) return null;
  const visible = (element: HTMLElement) => element.getClientRects().length > 0;
  const regions = [...document.querySelectorAll<HTMLElement>("main, [role=main]")].filter(visible);
  if (regions.length !== 1) return null;
  const timelines = [...regions[0]!.querySelectorAll<HTMLElement>("infinite-scroller")]
    .filter((timeline) => visible(timeline)
      && [...timeline.querySelectorAll<HTMLElement>("user-query, model-response")].some(visible));
  return timelines.length === 1 ? { conversationId: route[1]!, url: url.href } : null;
}

export function observeGeminiIdentity(expectedUrl: string): boolean {
  if (location.origin !== "https://gemini.google.com" || location.href !== expectedUrl) return false;
  const runtime = (globalThis as typeof globalThis & {
    chrome?: { runtime?: { sendMessage: (message: { kind: string }) => Promise<unknown> } }
  }).chrome?.runtime;
  if (!runtime) return false;
  const scope = globalThis as typeof globalThis & { geminiIdentityObserver?: MutationObserver };
  if (scope.geminiIdentityObserver) return true;
  const root = document.documentElement;
  const observer = new MutationObserver(() => {
    if (!root.isConnected || location.href !== expectedUrl) {
      observer.disconnect();
      delete scope.geminiIdentityObserver;
      void runtime.sendMessage({ kind: "gemini_identity_changed" }).catch(() => {});
    }
  });
  observer.observe(root, { childList: true, attributes: true, subtree: true });
  scope.geminiIdentityObserver = observer;
  return true;
}

export function captureGeminiSnapshot(): { messages: GeminiRenderedMessage[] } | null {
  if (location.origin !== "https://gemini.google.com") return null;
  const route = location.pathname.split("/").filter(Boolean);
  if (route.length !== 2 || route.some((segment) => !/^[A-Za-z0-9_-]{1,128}$/.test(segment))) return null;

  const visible = (element: HTMLElement) => element.getClientRects().length > 0;
  const regions = [...document.querySelectorAll<HTMLElement>("main, [role=main]")].filter(visible);
  if (regions.length !== 1) return null;
  const timelines = [...regions[0]!.querySelectorAll<HTMLElement>("infinite-scroller")]
    .filter((timeline) => visible(timeline) && timeline.querySelector("user-query, model-response"));
  if (timelines.length !== 1) return null;
  const timeline = timelines[0]!;
  const rows = [...timeline.querySelectorAll<HTMLElement>("user-query, model-response")].filter(visible);
  if (!rows.length || rows.length > 32) return null;

  const messages: GeminiRenderedMessage[] = [];
  for (const row of rows) {
    if (row.closest("infinite-scroller") !== timeline) return null;
    let text: string;
    if (row.localName === "user-query") {
      const content = row.querySelectorAll<HTMLElement>("user-query-content");
      if (content.length !== 1) return null;
      const lines = [...content[0]!.querySelectorAll<HTMLElement>("p.query-text-line")].filter(visible);
      if (!lines.length) return null;
      text = lines.map((line) => line.innerText).join("\n").trim();
    } else {
      const content = row.querySelectorAll<HTMLElement>("model-response-content");
      if (content.length !== 1) return null;
      text = content[0]!.innerText.trim();
    }
    if (!text || text.length > 2048) return null;
    messages.push({ direction: row.localName === "user-query" ? "outgoing" : "incoming", text });
  }
  return new TextEncoder().encode(JSON.stringify(messages)).length <= 64 * 1024 ? { messages } : null;
}