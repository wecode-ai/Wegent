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

function normalizeDomain(value: string): string | undefined {
  const domain = value
    .replace(/^\*\./, '')
    .replace(/^https?:\/\//i, '')
    .split('/')[0]
    ?.replace(/[),.;:]+$/, '')
    .toLowerCase()
  if (!domain) return undefined
  return domain.startsWith('www.') ? domain.slice(4) : domain
}

function getFaviconUrl(domain: string): string {
  return `https://${domain}/favicon.ico`
}

class GitHubRecognizer implements LinkRecognizer {
  readonly provider = 'github'

  private static GITHUB_ICON = 'https://github.githubassets.com/favicons/favicon.svg'

  match(url: string): RecognizedLink | undefined {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return undefined
    }
    const domain = normalizeDomain(parsed.hostname)
    if (domain !== 'github.com') return undefined

    const path = parsed.pathname.replace(/^\//, '').split('/').filter(Boolean)
    if (path.length === 0) return undefined

    const owner = path[0]
    if (path.length === 1) {
      return {
        url,
        label: owner,
        iconUrl: GitHubRecognizer.GITHUB_ICON,
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
        iconUrl: GitHubRecognizer.GITHUB_ICON,
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
        iconUrl: GitHubRecognizer.GITHUB_ICON,
        provider: this.provider,
        fullUrl: url,
        isAbbreviated: true,
      }
    }

    return {
      url,
      label: url,
      iconUrl: GitHubRecognizer.GITHUB_ICON,
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

const recognizers: readonly LinkRecognizer[] = [
  new GitHubRecognizer(),
  new WegentSitesProjectRecognizer(),
]

export function getRecognizedLink(url: string): RecognizedLink | undefined {
  for (const recognizer of recognizers) {
    const result = recognizer.match(url)
    if (result) return result
  }
  return undefined
}

const FIRST_URL_REGEX = /https?:\/\/[^\s)\]}]+/i
const TRAILING_PUNCTUATION_REGEX = /[),.;:]+$/

export function extractFirstLink(text: string): LinkPreview | undefined {
  const match = FIRST_URL_REGEX.exec(text)
  if (!match) return undefined

  const raw = match[0].replace(TRAILING_PUNCTUATION_REGEX, '')
  try {
    const parsed = new URL(raw)
    const domain = normalizeDomain(parsed.hostname)
    if (!domain) return undefined
    const path = `${parsed.pathname}${parsed.search}${parsed.hash}`
    const displayUrl = `${domain}${path === '/' ? '' : path.replace(TRAILING_PUNCTUATION_REGEX, '')}`
    return {
      url: parsed.toString(),
      domain,
      displayUrl,
      iconUrl: getFaviconUrl(domain),
    }
  } catch {
    return undefined
  }
}
