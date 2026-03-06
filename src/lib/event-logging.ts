import { config } from './config'
import { logger } from './logger'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EventLogLevel = 'info' | 'warn' | 'error'

export type VendorStatus = 'pending' | 'sent' | 'failed' | 'skipped'

export interface EventLogEntry {
  id: number
  workspace_id: number
  level: EventLogLevel
  source: string
  message: string
  detail: string | null
  vendor_status: VendorStatus
  vendor_response: string | null
  vendor_sent_at: number | null
  created_at: number
}

export interface CreateEventLogInput {
  level: EventLogLevel
  source: string
  message: string
  detail?: Record<string, unknown> | null
}

// ---------------------------------------------------------------------------
// OAuth 2.0 Client Credentials token cache
// ---------------------------------------------------------------------------

interface TokenCache {
  accessToken: string
  expiresAt: number
}

let cachedToken: TokenCache | null = null

function isTokenValid(): boolean {
  if (!cachedToken) return false
  // Expire 60s early to avoid edge-case clock drift
  return Date.now() < cachedToken.expiresAt - 60_000
}

async function acquireOAuthToken(): Promise<string> {
  if (isTokenValid()) return cachedToken!.accessToken

  const { vendorTokenUrl, vendorClientId, vendorClientSecret, vendorAudience, vendorScope } =
    config.eventLogging

  if (!vendorTokenUrl || !vendorClientId || !vendorClientSecret) {
    throw new Error('Event logging vendor OAuth not configured (missing token URL, client ID, or secret)')
  }

  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: vendorClientId,
    client_secret: vendorClientSecret,
  })
  if (vendorAudience) params.set('audience', vendorAudience)
  if (vendorScope) params.set('scope', vendorScope)

  const res = await fetch(vendorTokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
    signal: AbortSignal.timeout(10_000),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`OAuth token request failed: HTTP ${res.status} — ${body.slice(0, 200)}`)
  }

  const json = (await res.json()) as { access_token: string; expires_in?: number; token_type?: string }

  if (!json.access_token) {
    throw new Error('OAuth token response missing access_token')
  }

  const expiresInMs = (json.expires_in ?? 3600) * 1000
  cachedToken = {
    accessToken: json.access_token,
    expiresAt: Date.now() + expiresInMs,
  }

  logger.info('Event logging vendor OAuth token acquired')
  return cachedToken.accessToken
}

/** Invalidate cached token (e.g. after a 401 from vendor). */
export function clearOAuthTokenCache(): void {
  cachedToken = null
}

// ---------------------------------------------------------------------------
// Vendor API forwarding
// ---------------------------------------------------------------------------

export interface VendorForwardResult {
  status: VendorStatus
  response: string | null
}

/**
 * Forward an event log entry to the third-party vendor.
 * Returns the status and a truncated response body.
 *
 * When the vendor integration is disabled or not configured, returns 'skipped'.
 */
export async function forwardToVendor(entry: CreateEventLogInput): Promise<VendorForwardResult> {
  const { enabled, vendorBaseUrl } = config.eventLogging

  if (!enabled || !vendorBaseUrl) {
    return { status: 'skipped', response: null }
  }

  try {
    const token = await acquireOAuthToken()

    // TODO: Replace '/events' with the actual vendor endpoint path once known.
    const url = `${vendorBaseUrl.replace(/\/+$/, '')}/events`

    const body = JSON.stringify({
      level: entry.level,
      source: entry.source,
      message: entry.message,
      detail: entry.detail ?? null,
      timestamp: new Date().toISOString(),
    })

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    })

    const responseText = await res.text().catch(() => '')
    const truncated = responseText.length > 500 ? responseText.slice(0, 500) + '...' : responseText

    if (res.ok) {
      return { status: 'sent', response: truncated }
    }

    // 401 likely means token expired / revoked — clear cache for next attempt
    if (res.status === 401) {
      clearOAuthTokenCache()
    }

    logger.warn(
      { status: res.status, response: truncated },
      'Event logging vendor returned non-2xx'
    )
    return { status: 'failed', response: `HTTP ${res.status}: ${truncated}` }
  } catch (err: any) {
    logger.error({ err }, 'Failed to forward event log to vendor')
    return { status: 'failed', response: err.message?.slice(0, 500) ?? 'Unknown error' }
  }
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

/**
 * Insert an event log entry into the database and optionally forward to vendor.
 */
export async function createEventLog(
  input: CreateEventLogInput,
  workspaceId: number = 1
): Promise<EventLogEntry> {
  const { getDatabase } = await import('./db')
  const db = getDatabase()

  const detailJson = input.detail ? JSON.stringify(input.detail) : null

  const result = db.prepare(`
    INSERT INTO event_logs (workspace_id, level, source, message, detail, vendor_status)
    VALUES (?, ?, ?, ?, ?, 'pending')
  `).run(workspaceId, input.level, input.source, input.message, detailJson)

  const id = Number(result.lastInsertRowid)

  // Fire-and-forget vendor forwarding — don't block the caller
  forwardToVendor(input).then((vendorResult) => {
    try {
      db.prepare(`
        UPDATE event_logs
        SET vendor_status = ?, vendor_response = ?, vendor_sent_at = unixepoch()
        WHERE id = ?
      `).run(vendorResult.status, vendorResult.response, id)
    } catch (updateErr) {
      logger.error({ err: updateErr, eventLogId: id }, 'Failed to update event log vendor status')
    }
  }).catch((err) => {
    logger.error({ err, eventLogId: id }, 'Vendor forwarding promise rejected')
  })

  return {
    id,
    workspace_id: workspaceId,
    level: input.level,
    source: input.source,
    message: input.message,
    detail: detailJson,
    vendor_status: 'pending',
    vendor_response: null,
    vendor_sent_at: null,
    created_at: Math.floor(Date.now() / 1000),
  }
}

/**
 * Query event logs with optional filters.
 */
export function queryEventLogs(opts: {
  workspaceId?: number
  level?: EventLogLevel
  source?: string
  limit?: number
  offset?: number
  since?: number
}): { logs: EventLogEntry[]; total: number } {
  // Lazy import to avoid circular dep during module init
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getDatabase } = require('./db') as typeof import('./db')
  const db = getDatabase()

  const workspaceId = opts.workspaceId ?? 1
  const limit = Math.min(opts.limit ?? 100, 500)
  const offset = opts.offset ?? 0

  const conditions: string[] = ['workspace_id = ?']
  const params: (string | number)[] = [workspaceId]

  if (opts.level) {
    conditions.push('level = ?')
    params.push(opts.level)
  }
  if (opts.source) {
    conditions.push('source = ?')
    params.push(opts.source)
  }
  if (opts.since) {
    conditions.push('created_at > ?')
    params.push(opts.since)
  }

  const where = conditions.join(' AND ')

  const logs = db
    .prepare(`SELECT * FROM event_logs WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as EventLogEntry[]

  const countRow = db
    .prepare(`SELECT COUNT(*) as total FROM event_logs WHERE ${where}`)
    .get(...params) as { total: number }

  return { logs, total: countRow.total }
}
