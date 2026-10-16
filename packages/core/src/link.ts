/** One URL normalization rule for typing, paste, the link popover, HTML, and Markdown. */

const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
/**
 * Schemes that never become links: they can run script or reach local files when an exported
 * note is opened in a browser. The panel only ever opens web, mail, and Raycast links anyway.
 */
const BLOCKED_SCHEMES = new Set(["javascript:", "data:", "vbscript:", "file:"]);
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/** Well-known top-level domains for the strict "looks like a URL" test. */
const KNOWN_TLDS = new Set(
  (
    "com net org edu gov mil int io dev app ai co me info biz xyz tech site online store blog cloud page link " +
    "design studio agency email live news shop art one pro so sh gg fm tv to ly is it at be ch de fr uk us ca au " +
    "nz jp cn kr in br mx es pt nl se no fi dk pl cz sk hu ro bg gr tr ru ua ie il za ar cl pe ve sg hk tw my th " +
    "vn id ph ae sa eu asia"
  ).split(" "),
);

function splitHost(rest: string): { host: string; port: string; tail: string } | null {
  const match = /^([^/?#:\s]+)(:\d{1,5})?([/?#].*)?$/.exec(rest);
  if (!match) return null;
  return { host: match[1] ?? "", port: match[2] ?? "", tail: match[3] ?? "" };
}

function isIPv4(host: string): boolean {
  return IPV4.test(host) && host.split(".").every((part) => Number(part) <= 255);
}

function isDomain(host: string): boolean {
  const labels = host.split(".");
  return (
    labels.length >= 2 &&
    labels.every((label) => HOST_LABEL.test(label)) &&
    /^[a-z]{2,63}$/i.test(labels[labels.length - 1] ?? "")
  );
}

function isBareHost(input: string): boolean {
  const parts = splitHost(input);
  if (!parts) return false;
  const host = parts.host.toLowerCase();
  return host === "localhost" || isIPv4(host) || isDomain(host);
}

function parses(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** Normalizes user input into a link target, or returns null when it is not a valid link. */
export function normalizeLinkHref(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (BLOCKED_SCHEMES.has(SCHEME.exec(trimmed)?.[0].toLowerCase() ?? "")) return null;
  const hasWhitespace = /\s/.test(trimmed);
  let candidate: string;
  if (trimmed.startsWith("//")) {
    candidate = `https:${trimmed}`;
  } else if (isBareHost(trimmed)) {
    candidate = `https://${trimmed}`;
  } else if (SCHEME.test(trimmed)) {
    candidate = trimmed;
  } else {
    return null;
  }
  const url = parses(candidate);
  if (!url) return null;
  if (BLOCKED_SCHEMES.has(url.protocol.toLowerCase())) return null;
  return hasWhitespace ? url.href : candidate;
}

/** The stricter test used for auto-linking and for treating a paste as a single URL. */
export function looksLikeUrl(input: string): boolean {
  const text = input.trim();
  if (!text || /\s/.test(text)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^mailto:/i.test(text) || text.startsWith("//")) {
    return normalizeLinkHref(text) !== null;
  }
  const parts = splitHost(text);
  if (!parts) return false;
  const host = parts.host.toLowerCase();
  if (host === "localhost" || isIPv4(host)) return true;
  if (!isDomain(host)) return false;
  return KNOWN_TLDS.has(host.split(".").pop() ?? "");
}
