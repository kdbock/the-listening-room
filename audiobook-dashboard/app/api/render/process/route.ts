export const dynamic = "force-dynamic";

const defaultWorkerUrl = "https://the-listening-room-render-worker-403845109525.us-east1.run.app";

function workerBaseUrl() {
  return (process.env.RENDER_WORKER_URL || defaultWorkerUrl).replace(/\/+$/, "");
}

export async function POST() {
  const response = await fetch(`${workerBaseUrl()}/process-next`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    cache: "no-store",
  });

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = { ok: false, error: "Render worker returned a non-JSON response." };
  }

  return Response.json(payload, { status: response.status });
}
