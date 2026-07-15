import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

export const dynamic = "force-dynamic";

const projectRoot = path.resolve(process.cwd(), "..");
const soundLibraryRoot = path.join(projectRoot, "Sound Library Downloads");

function contentTypeFor(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".wav") return "audio/wav";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".aif" || ext === ".aiff") return "audio/aiff";
  if (ext === ".m4a") return "audio/mp4";
  return "application/octet-stream";
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const relativePath = url.searchParams.get("path") || "";
  if (!relativePath) {
    return Response.json({ error: "Missing sound library path." }, { status: 400 });
  }

  const resolvedPath = path.resolve(soundLibraryRoot, relativePath);
  const relativeToRoot = path.relative(soundLibraryRoot, resolvedPath);
  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    return Response.json({ error: "Sound path is outside the local sound library." }, { status: 403 });
  }

  try {
    const fileStat = await stat(resolvedPath);
    if (!fileStat.isFile()) {
      return Response.json({ error: "Sound path is not a file." }, { status: 404 });
    }
    const stream = Readable.toWeb(createReadStream(resolvedPath));
    return new Response(stream as ReadableStream, {
      headers: {
        "Content-Type": contentTypeFor(resolvedPath),
        "Content-Length": String(fileStat.size),
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return Response.json({ error: "Sound file was not found." }, { status: 404 });
  }
}
