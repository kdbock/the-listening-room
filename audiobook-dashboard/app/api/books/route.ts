export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ error: "Books now load from Firestore in the app client." }, { status: 410 });
}

export async function POST() {
  return Response.json({ error: "Books now save through Firestore in the app client." }, { status: 410 });
}

export async function PATCH() {
  return Response.json({ error: "Books now save through Firestore in the app client." }, { status: 410 });
}
