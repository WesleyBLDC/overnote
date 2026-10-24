/**
 * The one place the browser harness ports come from.
 * OVERNOTE_HARNESS_PORT is the dev server (default 5199) and OVERNOTE_PREVIEW_PORT is the built
 * preview (default: the dev port minus one, 5198). scripts/verify.sh sets both to a free pair per
 * run, so parallel worktrees never share a server.
 */
function readPort(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`${name} must be a port number, got "${raw}"`);
  return port;
}

export const HARNESS_PORT = readPort("OVERNOTE_HARNESS_PORT", 5199);
export const PREVIEW_PORT = readPort("OVERNOTE_PREVIEW_PORT", HARNESS_PORT - 1);
export const HARNESS_ORIGIN = `http://127.0.0.1:${HARNESS_PORT}`;
export const PREVIEW_ORIGIN = `http://127.0.0.1:${PREVIEW_PORT}`;
