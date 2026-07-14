export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ error: "Materials now load from Firebase Storage in the app client." }, { status: 410 });
}

export async function POST() {
  return Response.json({ error: "Materials now upload through Firebase Storage in the app client." }, { status: 410 });
}

export async function DELETE() {
  return Response.json({ error: "Materials now delete through Firebase Storage in the app client." }, { status: 410 });
}
