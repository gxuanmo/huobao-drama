/**
 * fetchWithRetry — 包一层 global fetch，对瞬时网络错误和可重试的 HTTP 状态码重试。
 *
 * 背景：
 * 1. Node 内置 undici 在 DNS 返回多 IP 时，可能卡死在不可达的 IP 上，
 *    直到 connectTimeout（默认 10s）才换下一个，最终抛 TypeError("fetch failed")。
 *    表面消息没有任何信息——真实原因藏在 err.cause（如 UND_ERR_CONNECT_TIMEOUT）。
 * 2. Ali Dashscope 等厂商对 RPM 有限制，超出会返 429 Throttling.RateQuota，
 *    带回 Retry-After 头或者直接让调用方退避。
 *
 * 这里在传输层错误上做退避重试，也支持对指定 HTTP 状态码（默认 429/502/503/504）
 * 自动重试，并提供 formatFetchError 把 cause 拉出来。
 */

const TRANSIENT_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EPIPE',
])

const DEFAULT_RETRY_STATUS = [429, 502, 503, 504]

export interface RetryOpts {
  maxAttempts?: number
  initialDelayMs?: number
  /** HTTP 状态码列表，命中则重试。默认 [429,502,503,504]。传 [] 禁用。 */
  retryOnStatus?: number[]
  onRetry?: (attempt: number, reason: unknown) => void
}

function getErrCode(err: any): string | undefined {
  return err?.cause?.code || err?.code
}

export function isTransientFetchError(err: unknown): boolean {
  const code = getErrCode(err)
  return !!code && TRANSIENT_CODES.has(code)
}

/**
 * 解析 Retry-After 头。支持秒数（如 "30"）或 HTTP 日期。返回毫秒。
 */
function parseRetryAfter(header: string | null): number | null {
  if (!header) return null
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const dateMs = Date.parse(header)
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now())
  return null
}

export async function fetchWithRetry(
  url: string | URL,
  init?: RequestInit,
  opts: RetryOpts = {},
): Promise<Response> {
  const maxAttempts = opts.maxAttempts ?? 4
  const initialDelay = opts.initialDelayMs ?? 600
  const retryStatus = new Set(opts.retryOnStatus ?? DEFAULT_RETRY_STATUS)
  let lastErr: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await fetch(url, init)
      if (retryStatus.has(resp.status) && attempt < maxAttempts) {
        const retryAfterMs = parseRetryAfter(resp.headers.get('retry-after'))
        const delay = retryAfterMs ?? initialDelay * Math.pow(2, attempt - 1)
        opts.onRetry?.(attempt, { status: resp.status, delayMs: delay })
        // 消费掉 body 避免连接泄漏
        try { await resp.arrayBuffer() } catch {}
        await new Promise(r => setTimeout(r, delay))
        continue
      }
      return resp
    } catch (err) {
      lastErr = err
      if (!isTransientFetchError(err) || attempt === maxAttempts) throw err
      opts.onRetry?.(attempt, err)
      await new Promise(r => setTimeout(r, initialDelay * attempt))
    }
  }
  throw lastErr
}

/**
 * 把 fetch 抛出的 TypeError("fetch failed") 解包成可读字符串，
 * 把 err.cause.code / err.cause.message 拉到外层。
 */
export function formatFetchError(err: unknown): string {
  if (!err) return 'Unknown error'
  const e = err as any
  const baseMsg = e.message || String(e)
  const cause = e.cause
  if (cause) {
    const causeCode: string | undefined = cause.code
    const causeMsg: string | undefined = cause.message
    if (causeCode || (causeMsg && causeMsg !== baseMsg)) {
      const parts = [baseMsg]
      if (causeCode) parts.push(`[${causeCode}]`)
      if (causeMsg && causeMsg !== baseMsg) parts.push(causeMsg)
      return parts.join(' ')
    }
  }
  return baseMsg
}
