export interface LinkPreview {
  url: string
  domain: string
  displayUrl: string
  iconUrl: string
}

export interface RecognizedLink {
  url: string
  label: string
  iconUrl: string
  provider: string
  fullUrl: string
  /** When true, the label is a human-readable simplification and not the full URL. */
  isAbbreviated: boolean
}

interface LinkRecognizer {
  readonly provider: string
  match(url: string): RecognizedLink | undefined
}

export function normalizeHostname(hostname: string): string | undefined {
  const domain = hostname
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/\.$/, '')
  return domain || undefined
}

export const GITHUB_ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23181717'%3E%3Cpath d='M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12'/%3E%3C/svg%3E"

class GitHubRecognizer implements LinkRecognizer {
  readonly provider = 'github'

  match(url: string): RecognizedLink | undefined {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return undefined
    }
    const domain = normalizeHostname(parsed.hostname)
    if (domain !== 'github.com') return undefined

    const path = parsed.pathname.replace(/^\//, '').split('/').filter(Boolean)
    if (path.length === 0) return undefined

    const owner = path[0]
    if (path.length === 1) {
      return {
        url,
        label: owner,
        iconUrl: GITHUB_ICON,
        provider: this.provider,
        fullUrl: url,
        isAbbreviated: true,
      }
    }

    const repo = path[1]
    const repoRef = `${owner}/${repo}`
    if (path.length === 2) {
      return {
        url,
        label: repoRef,
        iconUrl: GITHUB_ICON,
        provider: this.provider,
        fullUrl: url,
        isAbbreviated: true,
      }
    }

    const isPull = path[2] === 'pull'
    const isIssue = path[2] === 'issues'
    const number = path[3]
    if ((isPull || isIssue) && number) {
      return {
        url,
        label: `${repoRef}#${number}`,
        iconUrl: GITHUB_ICON,
        provider: this.provider,
        fullUrl: url,
        isAbbreviated: true,
      }
    }

    return {
      url,
      label: url,
      iconUrl: GITHUB_ICON,
      provider: this.provider,
      fullUrl: url,
      isAbbreviated: false,
    }
  }
}

class WegentSitesProjectRecognizer implements LinkRecognizer {
  readonly provider = 'wegent-sites-project'

  match(url: string): RecognizedLink | undefined {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return undefined
    }
    if (parsed.protocol !== 'wegent-sites-project:') return undefined
    let projectId: string
    try {
      projectId = decodeURIComponent(parsed.hostname || parsed.pathname.replace(/^\/+/, ''))
    } catch {
      return undefined
    }
    if (!projectId.trim()) return undefined

    return {
      url,
      label: projectId,
      iconUrl: '/plugin-icons/wework.svg',
      provider: this.provider,
      fullUrl: url,
      isAbbreviated: true,
    }
  }
}

class WebRecognizer implements LinkRecognizer {
  readonly provider = 'web'

  match(url: string): RecognizedLink | undefined {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return undefined
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
    const domain = normalizeHostname(parsed.hostname)
    if (!domain) return undefined
    const path = `${parsed.pathname.replace(/\/+$/, '')}${parsed.search}${parsed.hash}`
    const port = parsed.port ? `:${parsed.port}` : ''
    return {
      url,
      label: `${domain}${port}${path}`,
      iconUrl: '',
      provider: this.provider,
      fullUrl: url,
      isAbbreviated: true,
    }
  }
}

const recognizers: readonly LinkRecognizer[] = [
  new GitHubRecognizer(),
  new WegentSitesProjectRecognizer(),
  new WebRecognizer(),
]

export function getRecognizedLink(url: string): RecognizedLink | undefined {
  const trimmed = trimUrlBoundaries(url)
  for (const recognizer of recognizers) {
    const result = recognizer.match(trimmed)
    if (result) return result
  }
  return undefined
}

const BARE_URL_SOURCE = 'https?://[^\\s<]+'
export const BARE_HTTP_URL_REGEX = new RegExp(BARE_URL_SOURCE, 'gi')
const FIRST_URL_REGEX = new RegExp(BARE_URL_SOURCE, 'i')

const TRAILING_PUNCTUATION = /[.,;:!?'"`]/
const CLOSING_BRACKETS: Record<string, string> = { ')': '(', ']': '[', '}': '{' }

/**
 * Removes prose punctuation that is not part of the URL while keeping balanced
 * closing brackets. `"See (https://a.com/x)."` -> `"https://a.com/x"`, but
 * `"https://en.wikipedia.org/wiki/Foo_(bar)"` keeps its balanced parentheses.
 */
export function trimUrlBoundaries(value: string): string {
  let result = value
  while (result) {
    const last = result[result.length - 1]
    if (TRAILING_PUNCTUATION.test(last)) {
      result = result.slice(0, -1)
      continue
    }
    const open = CLOSING_BRACKETS[last]
    if (open) {
      let depth = 0
      for (let i = 0; i < result.length; i += 1) {
        if (result[i] === open) depth += 1
        else if (result[i] === last) depth -= 1
      }
      if (depth < 0) {
        result = result.slice(0, -1)
        continue
      }
    }
    break
  }
  return result
}

export function extractFirstLink(text: string): LinkPreview | undefined {
  const match = FIRST_URL_REGEX.exec(text)
  if (!match) return undefined
  const url = trimUrlBoundaries(match[0])
  try {
    const parsed = new URL(url)
    const domain = normalizeHostname(parsed.hostname)
    if (!domain) return undefined
    const path = `${parsed.pathname}${parsed.search}${parsed.hash}`
    const displayUrl = `${domain}${path === '/' ? '' : path}`
    return { url: parsed.toString(), domain, displayUrl, iconUrl: '' }
  } catch {
    return undefined
  }
}
