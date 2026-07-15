import { spawn } from "node:child_process";

const processes = [];
const soundPreviewPort = Number(process.env.SOUND_PREVIEW_PORT || 3217);
const nextPort = Number(process.env.PORT || 3000);

async function isServerRunning(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

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

if (await isServerRunning(`http://127.0.0.1:${soundPreviewPort}/health`)) {
  console.log(`[sound] Reusing existing sound preview server: http://127.0.0.1:${soundPreviewPort}`);
} else {
  start("sound", process.execPath, ["scripts/sound-preview-server.mjs"]);
}

if (await isServerRunning(`http://127.0.0.1:${nextPort}/`)) {
  console.log(`[next] Reusing existing app server: http://localhost:${nextPort}`);
  console.log("[dev] Servers are already running. Leave this terminal open or stop the old server before restarting.");
} else {
  start("next", process.execPath, ["node_modules/next/dist/bin/next", "dev"]);
}
