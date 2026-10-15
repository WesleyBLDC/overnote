// A stand-in for OvernoteHelper used by the launcher tests. It speaks the helper's socket
// protocol for the few methods the launcher needs, and records how it was started.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const VERSION = process.env.FAKE_HELPER_VERSION ?? "1.0.0";
const args = process.argv.slice(2);

if (args.includes("--version")) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

const option = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const supportDir = option("--support-dir");
const socketPath = option("--socket");
const pidFile = option("--pid-file");
const behavior = process.env.FAKE_HELPER_BEHAVIOR ?? "normal";

fs.mkdirSync(supportDir, { recursive: true });
fs.writeFileSync(path.join(supportDir, `args-${process.pid}.json`), JSON.stringify(args));

if (behavior === "crash") process.exit(3);

fs.writeFileSync(pidFile, `${process.pid}\n`);
let visible = args.includes("--show");

const cleanup = () => {
  try {
    if (fs.readFileSync(pidFile, "utf8").trim() === String(process.pid)) fs.rmSync(pidFile, { force: true });
  } catch {
    // Already gone.
  }
};
process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});

const server = net.createServer((socket) => {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const { id, method } = JSON.parse(line);
      const reply = (payload) => socket.write(`${JSON.stringify({ id, ...payload })}\n`);
      if (method === "system.ping") reply({ result: { version: VERSION, pid: process.pid } });
      else if (method === "window.toggle") {
        visible = !visible;
        reply({ result: { visible } });
      } else if (method === "system.shutdown") {
        if (behavior === "ignore-shutdown") return reply({ result: {} });
        reply({ result: {} });
        cleanup();
        server.close();
        setTimeout(() => process.exit(0), 20);
      } else reply({ error: { code: -32601, message: `Unknown method ${method}` } });
    }
  });
  socket.on("error", () => undefined);
});

fs.rmSync(socketPath, { force: true });
setTimeout(() => server.listen(socketPath), Number(process.env.FAKE_HELPER_DELAY_MS ?? 0));
