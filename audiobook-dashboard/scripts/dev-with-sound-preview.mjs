import { spawn } from "node:child_process";

const processes = [];

function start(label, command, args) {
  const child = spawn(command, args, { stdio: "pipe", env: process.env });
  processes.push(child);

  child.stdout.on("data", (chunk) => process.stdout.write(`[${label}] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[${label}] ${chunk}`));
  child.on("exit", (code, signal) => {
    if (signal) return;
    if (code && code !== 0) {
      console.error(`[${label}] exited with code ${code}`);
      shutdown(code);
    }
  });

  return child;
}

function shutdown(code = 0) {
  for (const child of processes) {
    if (!child.killed) child.kill("SIGINT");
  }
  setTimeout(() => process.exit(code), 200);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

start("sound", process.execPath, ["scripts/sound-preview-server.mjs"]);
start("next", process.execPath, ["node_modules/next/dist/bin/next", "dev"]);
