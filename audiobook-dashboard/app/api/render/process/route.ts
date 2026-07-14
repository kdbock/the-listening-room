export const dynamic = "force-dynamic";

export async function POST() {
  return Response.json({
    ok: false,
    error: "Cloud render dispatch is disabled. Queue local_qwen jobs and run npm run render:local on the render Mac.",
  }, { status: 410 });
}
