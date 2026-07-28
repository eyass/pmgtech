'use client'

/**
 * Error boundary. The most likely failure on a fresh deploy is a missing or
 * wrong Supabase service-role key, so the copy points at that first rather than
 * showing a bare stack trace.
 */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const looksLikeConfig =
    /supabase|environment variable|JWT|API key|fetch failed/i.test(error.message)

  return (
    <div className="mx-auto max-w-xl py-12">
      <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-6">
        <h1 className="text-lg font-semibold">Something went wrong</h1>

        {looksLikeConfig ? (
          <div className="mt-3 space-y-2 text-sm text-[var(--color-muted)]">
            <p>This looks like a configuration problem rather than a bug. Check that these are set:</p>
            <ul className="list-inside list-disc space-y-1">
              <li>
                <code className="rounded bg-[var(--color-line)] px-1">NEXT_PUBLIC_SUPABASE_URL</code>
              </li>
              <li>
                <code className="rounded bg-[var(--color-line)] px-1">
                  NEXT_PUBLIC_SUPABASE_ANON_KEY
                </code>
              </li>
              <li>
                <code className="rounded bg-[var(--color-line)] px-1">
                  SUPABASE_SERVICE_ROLE_KEY
                </code>
              </li>
            </ul>
            <p>
              After changing environment variables in Vercel you need to redeploy for them to take
              effect.
            </p>
          </div>
        ) : (
          <p className="mt-3 text-sm text-[var(--color-muted)]">
            The page could not be rendered. The detail below may help.
          </p>
        )}

        <pre className="mt-4 overflow-x-auto rounded-lg bg-[var(--color-canvas)] p-3 text-xs">
          {error.message}
        </pre>

        <button
          type="button"
          onClick={reset}
          className="mt-4 rounded-lg border border-[var(--color-line)] px-3 py-1.5 text-sm hover:bg-[var(--color-line)]"
        >
          Try again
        </button>
      </div>
    </div>
  )
}
