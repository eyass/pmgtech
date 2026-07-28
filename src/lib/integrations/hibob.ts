import { hibobEnv } from '@/lib/env'
import { IntegrationError, requestJson } from '@/lib/integrations/http'

/**
 * HiBob client. Uses the service-user credentials (id + token, basic auth)
 * against the People API. HiBob returns a deeply nested payload whose exact
 * shape depends on the tenant's field configuration, so everything here is
 * defensive: read what we recognise, ignore the rest.
 */

export interface HiBobEmployee {
  id: string
  email?: string
  displayName?: string
  firstName?: string
  surname?: string
  avatarUrl?: string
  work?: {
    title?: string
    department?: string
    site?: string
    startDate?: string
    reportsTo?: { email?: string; displayName?: string; id?: string } | null
    custom?: Record<string, unknown>
  }
  internal?: {
    status?: string
    terminationDate?: string | null
    lifecycleStatus?: string
  }
  employment?: {
    type?: string
    contract?: string
  }
  humanReadable?: Record<string, unknown>
  [key: string]: unknown
}

/** Flattened, app-shaped view of a HiBob person. */
export interface HiBobPerson {
  hibobId: string
  email: string | null
  fullName: string
  avatarUrl: string | null
  jobTitle: string | null
  department: string | null
  site: string | null
  startDate: string | null
  managerEmail: string | null
  employmentType: string | null
  isActive: boolean
}

export class HiBobClient {
  private readonly baseUrl: string
  private readonly auth: string

  constructor() {
    const env = hibobEnv()
    if (!env.serviceUserId || !env.serviceUserToken) {
      throw new IntegrationError(
        'HIBOB_SERVICE_USER_ID and HIBOB_SERVICE_USER_TOKEN must be configured',
        0,
        'hibob',
      )
    }
    this.baseUrl = env.baseUrl.replace(/\/+$/, '')
    this.auth = Buffer.from(`${env.serviceUserId}:${env.serviceUserToken}`).toString('base64')
  }

  /**
   * People search. HiBob's /v1/people/search is a POST that accepts the field
   * paths you want; asking for a narrow set keeps the payload manageable and
   * avoids pulling compensation data we have no business reading.
   */
  async employees(): Promise<HiBobPerson[]> {
    const { data } = await requestJson<{ employees?: HiBobEmployee[] }>(
      `${this.baseUrl}/v1/people/search`,
      {
        source: 'hibob',
        method: 'POST',
        headers: { Authorization: `Basic ${this.auth}` },
        body: {
          showInactive: true,
          // APPEND, not REPLACE. REPLACE rewrites values in place, which turns
          // work.startDate into a locale-formatted string ("20/07/2026") and
          // loses the ISO date Postgres needs — and the resolved list values it
          // gives are then the only copy, so there is nothing to fall back to.
          // APPEND keeps the machine values and adds a humanReadable sibling,
          // which is what normalisePerson below reads.
          humanReadable: 'APPEND',
          fields: [
            'root.id',
            'root.email',
            'root.displayName',
            'root.firstName',
            'root.surname',
            'root.avatarUrl',
            'work.title',
            'work.department',
            'work.site',
            'work.startDate',
            'work.reportsTo',
            'employment.type',
            'employment.contract',
            'internal.status',
            'internal.terminationDate',
            'internal.lifecycleStatus',
          ],
        },
        timeoutMs: 60_000,
      },
    )

    return (data?.employees ?? []).map(normalisePerson)
  }
}

function asString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  if (typeof value === 'number') return String(value)
  return null
}

/**
 * Dates go into `date` columns, so only an ISO calendar date is safe to pass on.
 * A locale-formatted value is dropped rather than guessed: "07/01/2025" is two
 * different days depending on the tenant's locale, and silently picking one
 * would put a wrong tenure on someone's profile.
 */
function asIsoDate(value: unknown): string | null {
  const raw = asString(value)
  if (!raw) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null
  return Number.isNaN(Date.parse(raw)) ? null : raw
}

function normalisePerson(raw: HiBobEmployee): HiBobPerson {
  const human = raw.humanReadable ?? {}
  const work = raw.work ?? {}

  // humanReadable carries resolved list values (department, site, title) which
  // are otherwise returned as opaque list-item ids.
  const humanWork = (human.work ?? {}) as Record<string, unknown>

  const composedName = [asString(raw.firstName), asString(raw.surname)].filter(Boolean).join(' ')
  const fullName = asString(raw.displayName) ?? (composedName.length > 0 ? composedName : 'Unknown')

  const status = (raw.internal?.status ?? raw.internal?.lifecycleStatus ?? '').toLowerCase()
  const terminated = Boolean(raw.internal?.terminationDate)

  return {
    hibobId: String(raw.id),
    email: asString(raw.email)?.toLowerCase() ?? null,
    fullName,
    avatarUrl: asString(raw.avatarUrl),
    jobTitle: asString(humanWork.title) ?? asString(work.title),
    department: asString(humanWork.department) ?? asString(work.department),
    site: asString(humanWork.site) ?? asString(work.site),
    startDate: asIsoDate(work.startDate),
    managerEmail: asString(work.reportsTo?.email)?.toLowerCase() ?? null,
    employmentType:
      asString((human.employment as Record<string, unknown> | undefined)?.type) ??
      asString(raw.employment?.type),
    isActive: !terminated && status !== 'inactive' && status !== 'terminated',
  }
}

/**
 * Map a HiBob department string onto one of our four squads.
 *
 * HiBob departments rarely match squad names exactly ("Engineering — Buyer",
 * "Tech / Seller Squad"), so matching is substring-based on the squad keyword.
 * Anything unrecognised returns null and is left for manual assignment in the
 * admin screen rather than being guessed.
 */
export function squadKeyFromDepartment(department: string | null): string | null {
  if (!department) return null
  const d = department.toLowerCase()
  if (/\bbuyer?s?\b|\bdemand\b/.test(d)) return 'buyer'
  if (/\bseller?s?\b|\bsupply\b/.test(d)) return 'seller'
  if (/monet|\bpayments?\b|\bpetpay\b|\bpricing\b/.test(d)) return 'monetization'
  if (/growth|acquisition|retention|lifecycle/.test(d)) return 'growth'
  return null
}
