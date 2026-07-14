export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ error: "Sounds now load from Firebase Storage in the app client." }, { status: 410 });
}

export async function POST() {
  return Response.json({ error: "Sounds now upload through Firebase Storage in the app client." }, { status: 410 });
}

export async function DELETE() {
  return Response.json({ error: "Sounds now delete through Firebase Storage in the app client." }, { status: 410 });
}
