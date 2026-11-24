import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const MAX_HISTORY_ENTRIES = 5_000
const HISTORY_PROTOCOLS = ['http:', 'https:', 'file:']
const CREDENTIAL_NAME =
  /(?:(?:(?:access|refresh|id|auth|oauth|session|reset[_-]?password)[_-]?)?token|api[_-]?key|client[_-]?(?:secret|assertion)|password|passwd|code[_-]?verifier|samlresponse|signature|x-amz-(?:signature|security-token)|x-goog-signature)/
const CREDENTIAL_PARAM = new RegExp(`^${CREDENTIAL_NAME.source}$`, 'i')
const CREDENTIAL_IN_TITLE = new RegExp(`(?:^|[?&#;\\s])${CREDENTIAL_NAME.source}=`, 'i')
const CAS_TICKET_VALUE = /(?:ST|PT|PGT|PGTIOU|TGT)-[^?#&;\s]+/
const CAS_TICKET = new RegExp(`^${CAS_TICKET_VALUE.source}`, 'i')
const CAS_TICKET_IN_TITLE = new RegExp(`(?:^|[?&#;\\s])ticket=${CAS_TICKET_VALUE.source}`, 'i')
const NESTED_URL = /^(?:[a-z][a-z\d+.-]*:\/\/|[/?#]|[^&=?#\s]+[?#])/i
const AUTH_ROUTE =
  /(?:^|[/#])(?:(?:auth(?:entication)?|authorize|oauth2?|oidc|sso|login|signin)(?:callback)?|callback)(?:$|[/?.#&_-])/i

function decodeHistoryEscapes(value: string, maxEscapeLength = Infinity): string {
  // Redirect targets may be percent-encoded more than once. Decode their ASCII
  // delimiters as well as field names without modifying the URL we keep.
  return value.replace(/%(?:25)*([\da-f]{2})/gi, (escape, hex: string) =>
    escape.length > maxEscapeLength
      ? '%' + escape.slice(maxEscapeLength)
      : String.fromCharCode(parseInt(hex, 16))
  )
}

function historyUrlReference(value: string): string {
  if (/[?#]/.test(value)) return value
  // Decode only to the first exposed query or fragment. Deeper redirect parameters
  // must stay encoded until their own URL is inspected.
  const delimiters = value.match(/%(?:25)*(?:3f|23)/gi)
  if (!delimiters) return decodeHistoryEscapes(value)
  const length = delimiters.reduce((min, delimiter) => Math.min(min, delimiter.length), Infinity)
  return decodeHistoryEscapes(value, length)
}

function hasUrlCredential(root: URL): boolean {
  const references = [root]
  const visited = new Set<string>()
  while (references.length) {
    const url = references.pop()!
    if (visited.has(url.href)) continue
    visited.add(url.href)
    if (url.username || url.password) return true
    const path = decodeHistoryEscapes(url.pathname)
    const authRoute =
      AUTH_ROUTE.test(path) ||
      /(?:^|[./])(?:cas|sso|idp)(?:[./]|$)|\/(?:serviceValidate|proxyValidate)\/?$/i.test(
        url.hostname + path
      )
    const hash = url.hash.slice(1)
    if (hash) {
      // Preserve encoded data inside the values of a parameter-list fragment.
      const fragment = /^[^/?#=]+=/.test(hash) ? '?' + hash : historyUrlReference(hash)
      const route = NESTED_URL.test(fragment) ? fragment : '?' + fragment
      const resolved = URL.parse(route, url)
      if (resolved) references.push(resolved)
    }
    // Match real field names. Encoded delimiters in ordinary values aren't field separators.
    const fields = new Set<string>()
    const search = url.search.slice(1)
    const query = search.includes('=') ? search : decodeHistoryEscapes(search)
    for (const [name, value] of new URLSearchParams(query.replaceAll(';', '&'))) {
      const key = decodeHistoryEscapes(name).toLowerCase()
      if (CREDENTIAL_PARAM.test(key)) return true
      if (key === 'ticket' && CAS_TICKET.test(decodeHistoryEscapes(value))) return true
      if (value) fields.add(key)
      const reference = historyUrlReference(value)
      if (NESTED_URL.test(reference)) {
        const resolved = URL.parse(reference, 'https://history.invalid')
        if (resolved) references.push(resolved)
      }
    }
    if (authRoute && fields.has('ticket')) return true
    if (
      fields.has('code') &&
      (authRoute || fields.has('client_id') || fields.has('redirect_uri') || fields.has('iss'))
    )
      return true
    if (
      fields.has('sv') &&
      fields.has('sig') &&
      ((fields.has('sp') && fields.has('se')) ||
        fields.has('sr') ||
        (fields.has('ss') && fields.has('srt')))
    ) {
      return true
    }
  }
  return false
}

function hasTitleCredential(value: string): boolean {
  const reference = historyUrlReference(value)
  const url = URL.parse(reference)
  let text = value
  if (url && HISTORY_PROTOCOLS.includes(url.protocol)) {
    if (hasUrlCredential(url)) return true
    // URL parsing can fold a title's appended text into the path or query.
    const suffix = value.search(/\s/)
    if (suffix === -1) return false
    text = value.slice(suffix)
  }
  const relativeUrl = URL.parse(historyUrlReference(text), 'https://history.invalid')
  const decoded = decodeHistoryEscapes(text)
  return (
    CREDENTIAL_IN_TITLE.test(decoded) ||
    CAS_TICKET_IN_TITLE.test(decoded) ||
    (relativeUrl !== null && hasUrlCredential(relativeUrl)) ||
    /\/\/[^/?#\s@]+@/.test(decoded)
  )
}

function isHistoryRecordableUrl(value: string): boolean {
  const url = URL.parse(value)
  return url !== null && HISTORY_PROTOCOLS.includes(url.protocol) && !hasUrlCredential(url)
}

export interface BrowserHistoryEntry {
  id: string
  url: string
  title: string | null
  visitTimeMs: number
}

export interface BrowserHistorySearch {
  text: string
  endTimeMs: number | null
  offset: number
  maxResults: number
  distinctUrls?: boolean
}

export class BrowserHistoryStore {
  private entries: BrowserHistoryEntry[] = []
  private loaded = false
  private sequence = 0
  private operation = Promise.resolve()

  constructor(private readonly path: string) {}

  search(input: BrowserHistorySearch): Promise<BrowserHistoryEntry[]> {
    return this.run(async () => {
      await this.load()
      const needle = input.text.trim().toLocaleLowerCase()
      const seen = input.distinctUrls ? new Set<string>() : undefined
      const results: BrowserHistoryEntry[] = []
      let offset = input.offset

      for (
        let index = this.entries.length - 1;
        index >= 0 && results.length < input.maxResults;
        index--
      ) {
        const entry = this.entries[index]
        if (input.endTimeMs != null && entry.visitTimeMs >= input.endTimeMs) continue
        if (
          needle &&
          !entry.url.toLocaleLowerCase().includes(needle) &&
          !entry.title?.toLocaleLowerCase().includes(needle)
        )
          continue
        if (seen?.has(entry.url)) continue
        seen?.add(entry.url)
        if (offset > 0) offset--
        else results.push(entry)
      }
      return results
    })
  }

  recordVisit(url: string, visitTimeMs: number, title: string | null): Promise<string | null> {
    return this.run(async () => {
      await this.load()
      if (!isHistoryRecordableUrl(url)) return null
      const id = `history-${visitTimeMs}-${++this.sequence}`
      this.entries.push({
        id,
        url,
        title: normalizedTitle(title),
        visitTimeMs,
      })
      if (this.entries.length > MAX_HISTORY_ENTRIES) {
        this.entries.splice(0, this.entries.length - MAX_HISTORY_ENTRIES)
      }
      await this.persist()
      return id
    })
  }

  backfillTitle(id: string, title: string): Promise<void> {
    return this.run(async () => {
      const normalized = normalizedTitle(title)
      if (!normalized) return
      await this.load()
      const entry = this.entries.find(candidate => candidate.id === id && candidate.title == null)
      if (!entry) return
      entry.title = normalized
      await this.persist()
    })
  }

  remove(ids: string[]): Promise<number> {
    return this.run(async () => {
      await this.load()
      const selected = new Set(ids)
      const previous = this.entries
      this.entries = previous.filter(entry => !selected.has(entry.id))
      const removed = previous.length - this.entries.length
      try {
        await this.persist()
      } catch (error) {
        this.entries = previous
        throw error
      }
      return removed
    })
  }

  clear(): Promise<void> {
    return this.run(async () => {
      // Explicit clearing can replace a corrupt file without parsing its contents.
      await this.persist([])
      this.entries = []
      this.loaded = true
    })
  }

  private run<T>(action: () => Promise<T>): Promise<T> {
    const result = this.operation.then(action, action)
    this.operation = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    let raw: string
    try {
      raw = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.loaded = true
        return
      }
      throw error
    }
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) throw new SyntaxError('Invalid browser history file')
    const safe: BrowserHistoryEntry[] = []
    let scrubbed = false
    for (const entry of parsed) {
      if (!isBrowserHistoryEntry(entry) || !isHistoryRecordableUrl(entry.url)) {
        scrubbed = true
        continue
      }
      const title = normalizedTitle(entry.title)
      if (title !== entry.title) scrubbed = true
      safe.push({ ...entry, title })
    }
    this.entries = safe
      .sort((left, right) => left.visitTimeMs - right.visitTimeMs)
      .slice(-MAX_HISTORY_ENTRIES)
    this.loaded = true
    if (scrubbed) {
      try {
        await this.persist()
      } catch (error) {
        // Reads use the sanitized snapshot. The next successful write also cleans the file.
        console.warn('[browser-history] Could not rewrite filtered visits', {
          code: (error as NodeJS.ErrnoException).code,
        })
      }
    }
  }

  private async persist(entries = this.entries): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const temporaryPath = `${this.path}.tmp`
    await writeFile(temporaryPath, JSON.stringify(entries), 'utf8')
    await rename(temporaryPath, this.path)
  }
}

function normalizedTitle(title: string | null): string | null {
  const normalized = title?.trim()
  return normalized && !hasTitleCredential(normalized) ? normalized : null
}

function isBrowserHistoryEntry(value: unknown): value is BrowserHistoryEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Partial<BrowserHistoryEntry>
  return (
    typeof entry.id === 'string' &&
    typeof entry.url === 'string' &&
    (entry.title === null || typeof entry.title === 'string') &&
    typeof entry.visitTimeMs === 'number' &&
    Number.isFinite(entry.visitTimeMs)
  )
}
