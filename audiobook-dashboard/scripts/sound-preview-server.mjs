import fs from "node:fs";
import { open, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

const dashboardRoot = process.cwd();
const projectRoot = path.resolve(dashboardRoot, "..");
const soundLibraryRoot = path.join(projectRoot, "Sound Library Downloads");
const port = Number(process.env.SOUND_PREVIEW_PORT || 3217);

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".wav") return "audio/wav";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".aif" || ext === ".aiff") return "audio/aiff";
  if (ext === ".m4a") return "audio/mp4";
  return "application/octet-stream";
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  response.end(JSON.stringify(body));
}

function parseRangeHeader(rangeHeader, fileSize) {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return null;

  const [, startText, endText] = match;
  if (!startText && !endText) return null;

  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;
    return { start: Math.max(fileSize - suffixLength, 0), end: fileSize - 1 };
  }

  const start = Number(startText);
  const end = endText ? Number(endText) : fileSize - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= fileSize) return null;
  return { start, end: Math.min(end, fileSize - 1) };
}

async function readRange(filePath, start, end) {
  const file = await open(filePath, "r");
  const length = end - start + 1;
  const buffer = Buffer.alloc(length);
  try {
    await file.read(buffer, 0, length, start);
    return buffer;
  } finally {
    await file.close();
  }
}

const server = http.createServer(async (request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Range, Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.url === "/health") {
    sendJson(response, 200, { ok: true, soundLibraryRoot });
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(response, 405, { error: "Method not allowed." });
    return;
  }

  const url = new URL(request.url || "/", `http://${request.headers.host || `127.0.0.1:${port}`}`);
  const relativePath = decodeURIComponent(url.pathname.replace(/^\/sound-library\/?/, ""));
  if (!url.pathname.startsWith("/sound-library/") || !relativePath) {
    sendJson(response, 404, { error: "Sound preview path not found." });
    return;
  }

  const resolvedPath = path.resolve(soundLibraryRoot, relativePath);
  const relativeToRoot = path.relative(soundLibraryRoot, resolvedPath);
  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    sendJson(response, 403, { error: "Sound path is outside the local sound library." });
    return;
  }

  try {
    const fileStat = await stat(resolvedPath);
    if (!fileStat.isFile()) {
      sendJson(response, 404, { error: "Sound path is not a file." });
      return;
    }

    const contentType = contentTypeFor(resolvedPath);
    const range = parseRangeHeader(request.headers.range, fileStat.size);
    if (request.headers.range && !range) {
      response.writeHead(416, {
        "Content-Range": `bytes */${fileStat.size}`,
        "Accept-Ranges": "bytes",
      });
      response.end();
      return;
    }

    if (range) {
      response.writeHead(206, {
        "Content-Type": contentType,
        "Content-Length": String(range.end - range.start + 1),
        "Content-Range": `bytes ${range.start}-${range.end}/${fileStat.size}`,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
      });
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      response.end(await readRange(resolvedPath, range.start, range.end));
      return;
    }

    response.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": String(fileStat.size),
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    fs.createReadStream(resolvedPath).pipe(response);
  } catch {
    sendJson(response, 404, { error: "Sound file was not found." });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Sound preview server: http://127.0.0.1:${port}`);
  console.log(`Sound library root: ${soundLibraryRoot}`);
});
