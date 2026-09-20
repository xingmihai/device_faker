import { parse as parseToml } from 'smol-toml'
import type {
  OnlineTemplateDetail,
  OnlineTemplateIndexItem,
  OnlineTemplateSource,
  Template,
  TemplateCategory,
  TemplateMeta,
} from '../types'
import { execCommand } from './ksu'
import { extractTemplateMeta, sanitizeTemplate } from './config'

const REQUEST_TIMEOUT_MS = 15000
const SHELL_TIMEOUT_SECONDS = Math.ceil(REQUEST_TIMEOUT_MS / 1000)
// Template files are tiny (~230 B) and served over HTTP/2 from jsDelivr or
// raw.githubusercontent, so the browser can sustain far more than 6 sockets.
// A larger window keeps the detail round trips from dominating load time.
const DETAIL_CONCURRENCY = 18
// Consecutive detail failures before we stop hammering a broken source.
const CIRCUIT_FAILURE_THRESHOLD = 8
const CIRCUIT_COOLDOWN_MS = 60 * 1000
export const CIRCUIT_OPEN_ERROR = 'circuit_open'
const FETCH_ACCEPT_TEXT = 'text/plain'
const FETCH_ACCEPT_JSON = 'application/json'
const FETCH_ACCEPT_GITHUB_JSON = 'application/vnd.github+json'

const SOURCE_CONFIGS = {
  gitee: {
    owner: 'Seyud',
    repo: 'device_faker_config_mirror',
    apiBase: 'https://gitee.com/api/v5',
    rawBase: 'https://gitee.com/Seyud/device_faker_config_mirror/raw/main',
    cdnBase: 'https://cdn.jsdelivr.net/gh/Seyud/device_faker_config@main',
  },
  github: {
    owner: 'Seyud',
    repo: 'device_faker_config',
    apiBase: 'https://api.github.com',
    rawBase: 'https://raw.githubusercontent.com/Seyud/device_faker_config/main',
    cdnBase: 'https://cdn.jsdelivr.net/gh/Seyud/device_faker_config@main',
  },
} as const satisfies Record<
  OnlineTemplateSource,
  {
    owner: string
    repo: string
    apiBase: string
    rawBase: string
    cdnBase: string
  }
>

export const TEMPLATE_CATEGORIES = {
  common: '通用设备',
  gaming: '游戏设备',
  transcend: '破限设备',
} as const satisfies Record<TemplateCategory, string>

const CATEGORY_ORDER: Record<TemplateCategory, number> = {
  common: 0,
  gaming: 1,
  transcend: 2,
}

interface TreeResponse {
  tree?: Array<{
    path?: string
    type?: string
    sha?: string
  }>
}

interface FileContentResponse {
  content?: string
  encoding?: string
  download_url?: string
}

export interface TemplateIndexLoadResult {
  source: OnlineTemplateSource
  items: OnlineTemplateIndexItem[]
}

export interface TemplateDetailLoadResult {
  id: string
  detail?: OnlineTemplateDetail
  error?: string
  version?: string
}

export interface LoadTemplateDetailsOptions {
  signal?: AbortSignal
  concurrency?: number
  chunkSize?: number
  onChunk?: (results: TemplateDetailLoadResult[]) => void
}

export class RateLimitError extends Error {
  constructor(message = 'API rate limit exceeded') {
    super(message)
    this.name = 'RateLimitError'
  }
}

export function isRateLimitError(error: unknown): boolean {
  return error instanceof Error && error.name === 'RateLimitError'
}

/**
 * Per-source failure circuit. The catalog holds 150+ templates, so without a
 * breaker a dead source burns a full timeout on every single entry.
 */
const circuitState = new Map<OnlineTemplateSource, { failures: number; openedAt: number | null }>()

function getCircuitState(source: OnlineTemplateSource) {
  const existing = circuitState.get(source)
  if (existing) {
    return existing
  }

  const created = { failures: 0, openedAt: null as number | null }
  circuitState.set(source, created)
  return created
}

function isCircuitOpen(source: OnlineTemplateSource): boolean {
  const state = getCircuitState(source)
  if (state.openedAt === null) {
    return false
  }

  if (Date.now() - state.openedAt >= CIRCUIT_COOLDOWN_MS) {
    state.openedAt = null
    state.failures = 0
    return false
  }

  return true
}

function recordCircuitFailure(source: OnlineTemplateSource) {
  const state = getCircuitState(source)
  state.failures += 1
  if (state.failures >= CIRCUIT_FAILURE_THRESHOLD) {
    state.openedAt = Date.now()
  }
}

function recordCircuitSuccess(source: OnlineTemplateSource) {
  const state = getCircuitState(source)
  state.failures = 0
  state.openedAt = null
}

/** Clears breaker state, e.g. when the user explicitly asks for a refresh. */
export function resetTemplateCircuits() {
  circuitState.clear()
}

function getSourceConfig(source: OnlineTemplateSource) {
  return SOURCE_CONFIGS[source]
}

function buildContentsApiUrl(source: OnlineTemplateSource, path: string): string {
  const config = getSourceConfig(source)
  return `${config.apiBase}/repos/${config.owner}/${config.repo}/contents/${path}?ref=main`
}

function buildTreeUrl(source: OnlineTemplateSource): string {
  const config = getSourceConfig(source)
  return `${config.apiBase}/repos/${config.owner}/${config.repo}/git/trees/main?recursive=1`
}

function buildRawUrl(source: OnlineTemplateSource, path: string): string {
  return `${getSourceConfig(source).rawBase}/${path}`
}

function buildCdnUrl(source: OnlineTemplateSource, path: string): string {
  return `${getSourceConfig(source).cdnBase}/${path}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  )
}

function assertNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new DOMException('The operation was aborted.', 'AbortError')
  }
}

function escapeShellArg(value: string): string {
  return value.replace(/'/g, "'\\''")
}

function decodeBase64Utf8(content: string): string {
  const binary = atob(content.replace(/\s+/g, ''))
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

function humanizeTemplateName(name: string): string {
  return name.replace(/[_-]+/g, ' ').trim()
}

function sortIndexItems(items: OnlineTemplateIndexItem[]): OnlineTemplateIndexItem[] {
  return [...items].sort((left, right) => {
    const categoryDiff = CATEGORY_ORDER[left.category] - CATEGORY_ORDER[right.category]
    if (categoryDiff !== 0) return categoryDiff

    const brandDiff = (left.brand || '').localeCompare(right.brand || '', undefined, {
      sensitivity: 'base',
    })
    if (brandDiff !== 0) return brandDiff

    return left.displayName.localeCompare(right.displayName, undefined, {
      sensitivity: 'base',
    })
  })
}

function buildTemplateIndexItem(
  source: OnlineTemplateSource,
  path: string,
  sha?: string
): OnlineTemplateIndexItem | null {
  const segments = path.split('/')
  if (segments.length < 3 || segments[0] !== 'templates') {
    return null
  }

  const category = segments[1] as TemplateCategory
  if (!(category in TEMPLATE_CATEGORIES)) {
    return null
  }

  const fileName = segments[segments.length - 1]
  if (!fileName.endsWith('.toml')) {
    return null
  }

  const name = fileName.replace(/\.toml$/i, '')
  const brand = segments.length > 3 ? segments[2] || null : null

  return {
    id: `${source}:${path}`,
    name,
    displayName: humanizeTemplateName(name),
    category,
    brand,
    path,
    sha,
    source,
    contentUrl: getDetailUrlCandidates(source, path)[0].url,
  }
}

async function requestTextViaFetch(
  url: string,
  signal?: AbortSignal,
  accept: string = FETCH_ACCEPT_JSON,
  cache: RequestCache = 'no-store'
): Promise<string> {
  assertNotAborted(signal)

  const controller = new AbortController()
  const onAbort = () => controller.abort()
  const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  if (signal) {
    signal.addEventListener('abort', onAbort, { once: true })
  }

  try {
    const response = await fetch(url, {
      headers: {
        Accept: accept,
      },
      cache,
      signal: controller.signal,
    })

    if (!response.ok) {
      const remaining = response.headers.get('X-RateLimit-Remaining')
      const retryAfter = response.headers.get('Retry-After')
      if (response.status === 429 || remaining === '0' || retryAfter !== null) {
        throw new RateLimitError()
      }

      throw new Error(`HTTP ${response.status}`)
    }

    return await response.text()
  } finally {
    window.clearTimeout(timeoutId)
    if (signal) {
      signal.removeEventListener('abort', onAbort)
    }
  }
}

async function requestTextViaShell(
  url: string,
  accept: string = FETCH_ACCEPT_JSON
): Promise<string> {
  if (import.meta.env?.DEV) {
    throw new Error('Shell HTTP fallback is not available in development mode.')
  }

  const escapedUrl = escapeShellArg(url)
  const escapedAccept = escapeShellArg(accept)
  // --max-time is required: without it a server that accepts the connection
  // but never responds hangs the shell fallback indefinitely.
  const curlCommand = `curl -fsSL --connect-timeout ${SHELL_TIMEOUT_SECONDS} --max-time ${SHELL_TIMEOUT_SECONDS} -H 'Accept: ${escapedAccept}' '${escapedUrl}'`
  const wgetCommand = `wget -q -O - --timeout=${SHELL_TIMEOUT_SECONDS} --header='Accept: ${escapedAccept}' '${escapedUrl}'`

  return await execCommand(`${curlCommand} || ${wgetCommand}`)
}

async function requestText(
  url: string,
  signal?: AbortSignal,
  accept: string = FETCH_ACCEPT_JSON,
  cache: RequestCache = 'no-store'
): Promise<string> {
  try {
    return await requestTextViaFetch(url, signal, accept, cache)
  } catch (error) {
    if (isAbortError(error)) {
      throw error
    }

    if (isRateLimitError(error)) {
      throw error
    }

    const fallback = await requestTextViaShell(url, accept)
    if (!fallback.trim()) {
      throw error instanceof Error ? error : new Error('Empty HTTP response')
    }

    return fallback
  }
}

async function requestJson<T>(
  url: string,
  signal?: AbortSignal,
  accept: string = FETCH_ACCEPT_JSON,
  cache: RequestCache = 'no-store'
): Promise<T> {
  const text = await requestText(url, signal, accept, cache)
  return JSON.parse(text) as T
}

function getDetailUrlCandidates(
  source: OnlineTemplateSource,
  path: string
): Array<{ url: string; accept: string }> {
  if (source === 'github') {
    return [
      { url: buildRawUrl('github', path), accept: FETCH_ACCEPT_TEXT },
      { url: buildCdnUrl('github', path), accept: FETCH_ACCEPT_TEXT },
    ]
  }

  // Gitee raw has no CORS headers (browser fetch is blocked) and the contents
  // API is rate-limited (60 requests/hour/IP), so prefer jsDelivr which serves
  // the GitHub mirror with CORS enabled and no API quota.
  return [
    { url: buildCdnUrl('gitee', path), accept: FETCH_ACCEPT_TEXT },
    { url: buildRawUrl('gitee', path), accept: FETCH_ACCEPT_TEXT },
    { url: buildContentsApiUrl('gitee', path), accept: FETCH_ACCEPT_JSON },
  ]
}

async function fetchTemplateContentViaContentsApi(
  source: OnlineTemplateSource,
  url: string,
  signal?: AbortSignal
): Promise<string> {
  const accept = source === 'github' ? FETCH_ACCEPT_GITHUB_JSON : FETCH_ACCEPT_JSON
  const response = await requestJson<unknown>(url, signal, accept)

  if (!isRecord(response)) {
    throw new Error('Template content response is invalid.')
  }

  const fileResponse = response as FileContentResponse
  if (typeof fileResponse.content === 'string' && fileResponse.encoding === 'base64') {
    return decodeBase64Utf8(fileResponse.content)
  }

  if (typeof fileResponse.download_url === 'string' && fileResponse.download_url) {
    return await requestText(fileResponse.download_url, signal, FETCH_ACCEPT_TEXT)
  }

  throw new Error('Template content is unavailable.')
}

async function loadTreeIndex(
  source: OnlineTemplateSource,
  signal?: AbortSignal
): Promise<TemplateIndexLoadResult> {
  const accept = source === 'github' ? FETCH_ACCEPT_GITHUB_JSON : FETCH_ACCEPT_JSON
  const response = await requestJson<TreeResponse>(buildTreeUrl(source), signal, accept)

  if (!Array.isArray(response.tree)) {
    throw new Error(`${source} tree response is invalid.`)
  }

  const items = response.tree
    .map((entry) => {
      if (entry.type !== 'blob' || typeof entry.path !== 'string') {
        return null
      }

      return buildTemplateIndexItem(source, entry.path, entry.sha)
    })
    .filter((item): item is OnlineTemplateIndexItem => item !== null)

  return {
    source,
    items: sortIndexItems(items),
  }
}

function getSourceFailoverOrder(preferredSource: OnlineTemplateSource): OnlineTemplateSource[] {
  return preferredSource === 'gitee' ? ['gitee', 'github'] : ['github', 'gitee']
}

export async function loadTemplateIndex(
  preferredSource: OnlineTemplateSource,
  signal?: AbortSignal
): Promise<TemplateIndexLoadResult> {
  const errors: string[] = []
  let rateLimited = false

  for (const source of getSourceFailoverOrder(preferredSource)) {
    try {
      return await loadTreeIndex(source, signal)
    } catch (error) {
      if (isAbortError(error)) {
        throw error
      }

      if (isRateLimitError(error)) {
        rateLimited = true
      }

      const message = error instanceof Error ? error.message : String(error)
      errors.push(`${source}: ${message}`)
    }
  }

  if (rateLimited) {
    throw new RateLimitError()
  }

  throw new Error(errors.join(' | ') || 'Failed to load template index.')
}

function parseTemplateDocument(content: string): OnlineTemplateDetail {
  const parsed = parseToml(content) as unknown

  if (!isRecord(parsed) || !isRecord(parsed.templates)) {
    throw new Error('Template TOML does not contain a valid templates section.')
  }

  const entries = Object.entries(parsed.templates)
  const firstTemplate = entries[0]?.[1]

  if (!firstTemplate) {
    throw new Error('Template TOML is empty.')
  }

  return {
    template: sanitizeTemplate(firstTemplate as Template),
    meta: extractTemplateMeta(firstTemplate) as TemplateMeta | undefined,
  }
}

async function fetchTemplateContent(
  item: OnlineTemplateIndexItem,
  signal?: AbortSignal
): Promise<string> {
  const candidates = getDetailUrlCandidates(item.source, item.path)
  let lastError: unknown = null

  for (const candidate of candidates) {
    try {
      if (candidate.accept === FETCH_ACCEPT_JSON) {
        return await fetchTemplateContentViaContentsApi(item.source, candidate.url, signal)
      }

      // Template files are content-addressed by ref and validated against the
      // tree sha, so letting the browser cache them is safe and saves a full
      // round trip on every revisit.
      const content = await requestText(candidate.url, signal, FETCH_ACCEPT_TEXT, 'default')
      if (content.trim()) {
        return content
      }

      lastError = new Error(`Template content for "${item.path}" is empty.`)
    } catch (error) {
      if (isAbortError(error)) {
        throw error
      }

      lastError = error
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Template content for "${item.path}" is unavailable.`)
}

export async function loadSingleTemplateDetail(
  item: OnlineTemplateIndexItem,
  signal?: AbortSignal
): Promise<TemplateDetailLoadResult> {
  try {
    if (isCircuitOpen(item.source)) {
      return {
        id: item.id,
        error: CIRCUIT_OPEN_ERROR,
        version: item.sha,
      }
    }

    const content = await fetchTemplateContent(item, signal)
    const detail = parseTemplateDocument(content)
    recordCircuitSuccess(item.source)

    return {
      id: item.id,
      detail,
      version: item.sha,
    }
  } catch (error) {
    if (isAbortError(error)) {
      throw error
    }

    recordCircuitFailure(item.source)

    return {
      id: item.id,
      error: error instanceof Error ? error.message : String(error),
      version: item.sha,
    }
  }
}

export async function loadTemplateDetails(
  items: OnlineTemplateIndexItem[],
  options: LoadTemplateDetailsOptions = {}
): Promise<TemplateDetailLoadResult[]> {
  const queue = [...items]
  const results: TemplateDetailLoadResult[] = []
  const pendingChunk: TemplateDetailLoadResult[] = []
  const concurrency = Math.max(1, options.concurrency ?? DETAIL_CONCURRENCY)
  const chunkSize = Math.max(1, options.chunkSize ?? concurrency)

  const flushChunk = () => {
    if (pendingChunk.length === 0 || !options.onChunk) {
      return
    }

    options.onChunk([...pendingChunk])
    pendingChunk.length = 0
  }

  async function worker() {
    while (queue.length > 0) {
      assertNotAborted(options.signal)
      const nextItem = queue.shift()
      if (!nextItem) {
        return
      }

      const result = await loadSingleTemplateDetail(nextItem, options.signal)
      results.push(result)
      pendingChunk.push(result)

      if (pendingChunk.length >= chunkSize) {
        flushChunk()
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length || 1) }, () => {
      return worker()
    })
  )

  flushChunk()
  return results
}
