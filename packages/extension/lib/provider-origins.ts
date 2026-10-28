export function parseDatabagOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 256) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value && url.href === `${value}/`
      && !url.username && !url.password && !url.hostname.includes("*")
      && url.origin !== "https://gemini.google.com" ? url.origin : null;
  } catch {
    return null;
  }
}

export function configuredDatabagOrigins(value: string | undefined): readonly string[] {
  if (value === undefined || value === "") return Object.freeze([]);
  const origin = parseDatabagOrigin(value);
  if (!origin) throw new Error("Databag requires one canonical HTTPS origin without a path or credentials");
  return Object.freeze([origin]);
}

declare const __DATABAG_ORIGINS__: readonly string[];
export const databagOrigins: readonly string[] = Object.freeze(
  typeof __DATABAG_ORIGINS__ === "undefined" ? [] : [...__DATABAG_ORIGINS__]);

export function isEligibleDatabagUrl(value: unknown, origins = databagOrigins): value is string {
  if (typeof value !== "string" || value.length > 512 || origins.length !== 1) return false;
  const origin = parseDatabagOrigin(origins[0]);
  return origin !== null && value === `${origin}/#/session`;
}