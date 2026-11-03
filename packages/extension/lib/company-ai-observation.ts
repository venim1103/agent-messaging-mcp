export function inspectCompanyAIChatStructure(input: { expectedUrl: string }) {
  if (!input || typeof input.expectedUrl !== "string" || input.expectedUrl.length > 512
    || window.top !== window || document.visibilityState !== "visible" || location.href !== input.expectedUrl) return null;
  const url = new URL(input.expectedUrl);
  if (url.protocol !== "https:" || url.port || url.username || url.password
    || !/^chat\.app\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.com$/.test(url.hostname) || !document.body) return null;

  const counts = { mainRegions: 0, timelines: 0, articles: 0, forms: 0, lists: 0,
    textareas: 0, contenteditables: 0, buttons: 0, links: 0, iframes: 0 };
  const editors: { kind: "textarea" | "contenteditable" | "textbox"; disabled: boolean; readOnly: boolean }[] = [];
  const pending: { element: Element; depth: number }[] = [{ element: document.body, depth: 0 }];
  let visitedElements = 0;
  let limited = false;
  let editorsOmitted = false;
  while (pending.length && visitedElements < 4096) {
    const entry = pending.pop()!;
    const element = entry.element;
    visitedElements++;
    if (entry.depth > 0 && element.nextElementSibling) {
      pending.push({ element: element.nextElementSibling, depth: entry.depth });
    }
    const tag = element.localName;
    if (["script", "style", "template", "noscript"].includes(tag)) continue;
    const style = getComputedStyle(element);
    if (element.hasAttribute("hidden") || element.hasAttribute("inert") || element.getAttribute("aria-hidden") === "true"
      || style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0) continue;
    if (element.getClientRects().length > 0) {
      const role = element.getAttribute("role");
      if (tag === "main" || role === "main") counts.mainRegions++;
      if (role === "log" || role === "feed") counts.timelines++;
      if (tag === "article" || role === "article") counts.articles++;
      if (tag === "form" || role === "form") counts.forms++;
      if (tag === "ol" || tag === "ul" || role === "list") counts.lists++;
      if (tag === "button" || role === "button") counts.buttons++;
      if (tag === "a" || role === "link") counts.links++;
      if (tag === "iframe") counts.iframes++;
      const editable = element.getAttribute("contenteditable");
      const contenteditable = editable === "" || editable === "true" || editable === "plaintext-only";
      if (tag === "textarea") counts.textareas++;
      if (contenteditable) counts.contenteditables++;
      const kind = tag === "textarea" ? "textarea" : contenteditable ? "contenteditable"
        : role === "textbox" && tag !== "input" ? "textbox" : null;
      if (kind) {
        if (editors.length < 8) editors.push({ kind,
          disabled: element.matches(":disabled") || element.getAttribute("aria-disabled") === "true",
          readOnly: element.hasAttribute("readonly") || element.getAttribute("aria-readonly") === "true" });
        else editorsOmitted = true;
      }
    }
    if (tag !== "iframe" && element.firstElementChild) {
      if (entry.depth >= 64) limited = true;
      else pending.push({ element: element.firstElementChild, depth: entry.depth + 1 });
    }
  }
  return { visitedElements, limited: limited || pending.length > 0, counts, editors, editorsOmitted };
}