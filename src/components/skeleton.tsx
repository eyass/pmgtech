/**
 * Loading placeholders for the route-level `loading.tsx` files.
 *
 * Every page in this app is `force-dynamic` and opens with a `Promise.all` of six to
 * eleven aggregate queries against Postgres. Until now none of them had a
 * `loading.tsx`, so a navigation showed the *previous* page, frozen, for as long as
 * the queries took — with the nav highlight already moved to the destination. That
 * reads as a broken click, and the natural response to it is to click again, which
 * starts the queries over.
 *
 * The shapes here deliberately match each page's real layout — a row of KPI cards,
 * then charts — rather than one generic spinner. A placeholder that lands where the
 * content will land stops the page jumping when it arrives, and tells the reader
 * which page they are waiting for.
 *
 * `aria-busy` and a single polite live region carry that to a screen reader, which
 * otherwise gets silence. The individual blocks are `aria-hidden`: announcing nine
 * grey rectangles is worse than announcing nothing.
 */

function Block({ className = '' }: { className?: string }) {
  return (
    <div aria-hidden className={`animate-pulse rounded-lg bg-[var(--color-line)] ${className}`} />
  )
}

function CardBlock({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-4">
      {children}
    </div>
  )
}

/**
 * @param kpis    how many KPI cards the real page opens with
 * @param charts  how many chart cards follow
 * @param table   whether the page ends in a table
 */
export function PageSkeleton({
  title,
  kpis = 4,
  charts = 2,
  table = false,
}: {
  title: string
  kpis?: number
  charts?: number
  table?: boolean
}) {
  return (
    <div className="space-y-6" aria-busy="true">
      <span className="sr-only" role="status">
        Loading {title}
      </span>

      <div>
        <h1 className="text-xl font-semibold">{title}</h1>
        <Block className="mt-2 h-4 w-64" />
      </div>

      {kpis > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: kpis }, (_, i) => (
            <CardBlock key={i}>
              <Block className="h-3 w-24" />
              <Block className="mt-3 h-7 w-20" />
              <Block className="mt-3 h-3 w-32" />
            </CardBlock>
          ))}
        </div>
      ) : null}

      {charts > 0 ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {Array.from({ length: charts }, (_, i) => (
            <CardBlock key={i}>
              <Block className="h-3 w-40" />
              <Block className="mt-4 h-48 w-full" />
            </CardBlock>
          ))}
        </div>
      ) : null}

      {table ? (
        <CardBlock>
          <Block className="h-3 w-36" />
          <div className="mt-4 space-y-2">
            {Array.from({ length: 6 }, (_, i) => (
              <Block key={i} className="h-9 w-full" />
            ))}
          </div>
        </CardBlock>
      ) : null}
    </div>
  )
}
