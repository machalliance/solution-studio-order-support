// Starts the agent, the Escalation Desk and the storefront together, shows their logs in one terminal, and stops all
// three together (Ctrl-C, or if any one of them exits). Used by `npm run dev` and `npm start`; each service can still be
// started by itself with its own script.
//
//   node scripts/run-all.mjs dev     hot-reloading dev servers
//   node scripts/run-all.mjs start   production-style (build the two Next.js apps first)
//
// Linux / macOS / WSL only (the same limit as the per-app scripts: on Windows use Docker).

import { spawn } from "node:child_process";
import net from "node:net";

const mode = process.argv[2];
if (mode !== "dev" && mode !== "start") {
  console.error("Usage: node scripts/run-all.mjs <dev|start>");
  process.exit(2);
}

const services = [
  { name: "agent", port: process.env.AGENT_PORT || "3006", workspace: "apps/agent" },
  { name: "desk", port: process.env.DESK_PORT || "3005", workspace: "apps/escalation-desk" },
  { name: "storefront", port: process.env.STOREFRONT_PORT || "3007", workspace: "apps/storefront" },
];

const portIsFree = (port) =>
  new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(Number(port));
  });

// A busy port is the usual first-run problem (an earlier run still going); say so plainly instead of letting the
// three services each fail in their own way.
const busy = [];
for (const service of services) if (!(await portIsFree(service.port))) busy.push(service);
if (busy.length > 0) {
  for (const service of busy) console.error(`Port ${service.port} (${service.name}) is already in use. Is WISMO already running? Stop it first, or set another port in .env.`);
  process.exit(1);
}

const children = new Map(); // service name -> child process
let stopping = false;
let exitCode = 0;

function prefixed(stream, name) {
  let pending = "";
  stream.on("data", (chunk) => {
    const lines = (pending + chunk.toString()).split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) console.log(`[${name}] ${line}`);
  });
  stream.on("end", () => {
    if (pending) console.log(`[${name}] ${pending}`);
  });
}

function stopAll(code) {
  if (stopping) return;
  stopping = true;
  exitCode = code;
  // Each service runs in its own process group (detached), so one signal to the group reaches npm, the shell and the
  // server underneath it; a plain kill of the npm process would leave the server running.
  for (const child of children.values()) {
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ }
  }
  setTimeout(() => {
    for (const child of children.values()) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    }
  }, 5000).unref();
}

for (const service of services) {
  const child = spawn("npm", ["run", mode, `--workspace=${service.workspace}`], { stdio: ["ignore", "pipe", "pipe"], detached: true });
  children.set(service.name, child);
  prefixed(child.stdout, service.name);
  prefixed(child.stderr, service.name);
  child.on("exit", (code, signal) => {
    children.delete(service.name);
    if (!stopping) {
      console.error(`[${service.name}] exited (${signal ?? `code ${code}`}); stopping the others.`);
      stopAll(1);
    }
    if (children.size === 0) process.exit(exitCode);
  });
}

process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));

console.log(`Starting (${mode}): agent http://localhost:${services[0].port} · Escalation Desk http://localhost:${services[1].port} · storefront http://localhost:${services[2].port}`);
console.log("Ctrl-C stops all three.");
