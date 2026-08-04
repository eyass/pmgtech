'use client'

/**
 * Last-resort boundary, for failures the ordinary one cannot reach.
 *
 * `app/error.tsx` renders *inside* the root layout, which is what keeps the header
 * and nav in place when a page throws. The cost of that is it cannot catch a failure
 * in the layout itself — and `RootLayout` does real work before rendering anything:
 * `currentUser()` reads cookies, validates the session against Supabase, and queries
 * `app_admins`. If the service-role key is wrong or Supabase is unreachable, that
 * throws, the layout never renders, and `error.tsx` never gets the chance to say so.
 * Without this file that case is a blank white page with nothing in it.
 *
 * Because the layout has not rendered, this component owns the whole document —
 * hence its own `<html>` and `<body>`, which is required here and forbidden
 * everywhere else. It also means the stylesheet the layout imports is not
 * guaranteed, so the styling below is deliberately inline rather than relying on
 * Tailwind classes or the CSS custom properties the rest of the app uses.
 *
 * Being reached at all is a signal in itself: a page-level bug lands in
 * `error.tsx`, so anything arriving here is almost always configuration or
 * connectivity, and the copy says so.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const code = { background: '#e2e8f0', borderRadius: 4, padding: '0 4px' }

  return (
    <html lang="en-GB">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          padding: '2rem',
          background: '#f6f7f9',
          color: '#0f172a',
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
        }}
      >
        <div style={{ maxWidth: '34rem', width: '100%' }}>
          <h1 style={{ fontSize: '1.125rem', fontWeight: 600, margin: 0 }}>
            The application failed to start
          </h1>

          <p style={{ fontSize: '0.875rem', color: '#64748b', marginTop: '0.75rem' }}>
            This failed before any page rendered, which almost always means the app cannot reach
            Supabase or is missing credentials — a bug in a single page would not land here. Check{' '}
            <code style={code}>SUPABASE_SERVICE_ROLE_KEY</code>,{' '}
            <code style={code}>NEXT_PUBLIC_SUPABASE_URL</code> and{' '}
            <code style={code}>NEXT_PUBLIC_SUPABASE_ANON_KEY</code>, then redeploy — environment
            variable changes in Vercel do not take effect until you do.
          </p>

          <pre
            style={{
              marginTop: '1rem',
              overflowX: 'auto',
              background: '#ffffff',
              border: '1px solid #e2e8f0',
              borderRadius: 8,
              padding: '0.75rem',
              fontSize: '0.75rem',
            }}
          >
            {error.message}
            {error.digest ? `\n\ndigest: ${error.digest}` : ''}
          </pre>

          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: '1rem',
              border: '1px solid #e2e8f0',
              background: '#ffffff',
              borderRadius: 8,
              padding: '0.375rem 0.75rem',
              fontSize: '0.875rem',
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  )
}
