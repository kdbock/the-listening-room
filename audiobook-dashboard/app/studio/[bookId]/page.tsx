import StudioWorkspace from "@/app/components/StudioWorkspace";

export default async function StudioPage({
  params,
}: {
  params: Promise<{ bookId: string }>;
}) {
  const { bookId } = await params;
  return <StudioWorkspace bookId={bookId} />;
}
