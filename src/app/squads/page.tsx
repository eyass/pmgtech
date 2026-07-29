import { redirect } from 'next/navigation'

/**
 * Squad comparison moved into the overview, which is where an org-level
 * comparison belongs. The route stays as a redirect rather than a 404 because it
 * is linked from older notes and from anyone's bookmarks.
 */
export default async function SquadsPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>
}) {
  const { period } = await searchParams
  redirect(period ? `/?period=${encodeURIComponent(period)}` : '/')
}
