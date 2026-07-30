import { redirect } from 'next/navigation'

/**
 * Sprints moved into the delivery page, where the rest of the flow metrics live.
 * The route stays as a redirect because it is bookmarked and linked from notes.
 */
export default async function SprintsPage({
  searchParams,
}: {
  searchParams: Promise<{ squad?: string }>
}) {
  const { squad } = await searchParams
  redirect(squad ? `/delivery?squad=${encodeURIComponent(squad)}` : '/delivery')
}
