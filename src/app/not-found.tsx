import Link from 'next/link'

import { EmptyState } from '@/components/ui'

/**
 * Styled 404, inside the app shell.
 *
 * `/people/[id]` and `/squads/[key]` already call `notFound()` for an unknown id and
 * for an ignored row — that part was wired. What was missing was this file, so those
 * calls landed on Next's built-in 404: unstyled, outside the layout, with no
 * navigation and nothing to say why. Someone following a stale link to an engineer
 * who has since been marked ignored got a dead end that looked like the app had
 * broken.
 *
 * The body names the ignored case explicitly, because it is the most common way to
 * reach here from a link that used to work, and it is not obvious from the outside.
 */
export default function NotFound() {
  return (
    <EmptyState
      title="Not found"
      body="This page does not exist. If you followed a link to an engineer or a squad, it may have been marked as ignored since — ignored rows are deliberately unreachable rather than shown as empty."
      action={
        <Link
          href="/"
          className="rounded-lg bg-[var(--color-ink)] px-3 py-1.5 text-sm text-[var(--color-surface)]"
        >
          Back to overview
        </Link>
      }
    />
  )
}
