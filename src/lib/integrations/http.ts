/**
 * Shared HTTP helper for the three integrations.
 *
 * All of GitLab, Jira and HiBob will rate-limit a backfill, and all three
 * occasionally return a 5xx that succeeds on retry. Rather than scatter that
 * handling across three clients, every request goes through requestJson.
 */

export class IntegrationError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly source: string,
    readonly body?: string,
  ) {
    super(message)
    this.name = 'IntegrationError'
  }
}

interface RequestOptions {
  source: string
  method?: string
  headers?: Record<string, string>
  body?: unknown
  /** Total attempts, including the first. */
  retries?: number
  timeoutMs?: number
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Honours Retry-After when the server sends it, otherwise backs off
 * exponentially with jitter so a fan-out of project syncs does not retry in
 * lockstep.
 */
function backoffMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 60_000)
  }
  const base = Math.min(1000 * 2 ** (attempt - 1), 30_000)
  return base + Math.floor(Math.random() * 500)
}

export async function requestJson<T>(url: string, options: RequestOptions): Promise<{
  data: T
  headers: Headers
}> {
  const { source, method = 'GET', headers = {}, body, retries = 4, timeoutMs = 30_000 } = options

  let lastError: Error | null = null

  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(url, {
        method,
        headers: {
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        cache: 'no-store',
      })

      if (!response.ok) {
        const text = await response.text().catch(() => '')

        if (RETRYABLE_STATUS.has(response.status) && attempt < retries) {
          await sleep(backoffMs(attempt, response.headers.get('retry-after')))
          continue
        }

        throw new IntegrationError(
          `${source} responded ${response.status} for ${method} ${redactUrl(url)}`,
          response.status,
          source,
          text.slice(0, 500),
        )
      }

      // 204s and empty bodies are legitimate for some endpoints.
      const text = await response.text()
      const data = (text.length > 0 ? JSON.parse(text) : null) as T
      return { data, headers: response.headers }
    } catch (error) {
      lastError = error as Error
      const isAbort = error instanceof Error && error.name === 'AbortError'
      const isIntegration = error instanceof IntegrationError

      // IntegrationError here means a non-retryable status; surface immediately.
      if (isIntegration) throw error
      if (attempt >= retries) break
      if (isAbort || error instanceof TypeError) {
        await sleep(backoffMs(attempt, null))
        continue
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  throw new IntegrationError(
    `${source} request failed after ${retries} attempts: ${lastError?.message ?? 'unknown error'}`,
    0,
    source,
  )
}

/** Strip query strings that may carry tokens before putting a URL in an error. */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return url
  }
}
