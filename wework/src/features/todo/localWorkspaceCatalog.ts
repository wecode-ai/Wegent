type LocalWorkspaceCatalog =
  | 'projects'
  | 'execution-environments'
  | 'agents'
  | 'default-agent'
  | 'agents-summary'
  | 'workspace-settings'
  | 'navigation-projects'
  | 'navigation-workspaces'

const ERROR_NAMES = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'AbortError',
  'TimeoutError',
  'NetworkError',
])

const catalogDiagnostics = new Map<LocalWorkspaceCatalog, Record<string, unknown>>()
let nextRequestId = 0

export const getLocalWorkspaceCatalogDiagnostics = () =>
  [...catalogDiagnostics].map(([catalog, diagnostic]) => ({ catalog, ...diagnostic }))

export async function loadWorkspaceCatalog<T>(
  catalog: LocalWorkspaceCatalog,
  load: () => Promise<T>
): Promise<T> {
  const requestId = ++nextRequestId
  const startedAt = performance.now()
  const persist = (entry: Record<string, unknown>) => {
    if (entry.status === 'started' || catalogDiagnostics.get(catalog)?.requestId === requestId) {
      catalogDiagnostics.set(catalog, entry)
    }
    return entry
  }
  const diagnostic = (status: string) => {
    const entry = {
      source: 'local',
      catalog,
      requestId,
      status,
      elapsedMs: Math.round(performance.now() - startedAt),
    }
    return persist(entry)
  }
  console.debug('[Wework] Local workspace catalog', JSON.stringify(diagnostic('started')))
  try {
    const result = await load()
    console.debug('[Wework] Local workspace catalog', JSON.stringify(diagnostic('fulfilled')))
    return result
  } catch (error) {
    const name = error instanceof Error ? error.name : 'Error'
    const message = error instanceof Error ? error.message : ''
    const status = error instanceof Error && 'status' in error ? error.status : null
    const reason =
      name === 'AbortError'
        ? 'aborted'
        : name === 'TimeoutError' || /timed?\s*out|timeout/i.test(message)
          ? 'timeout'
          : /network|fetch|connect/i.test(message)
            ? 'network'
            : 'rejected'
    // Persist only known classifications, never error text, response data or credentials.
    const failure = {
      ...diagnostic('rejected'),
      errorName: ERROR_NAMES.has(name) ? name : 'Error',
      reason,
      httpStatus:
        typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
          ? status
          : null,
    }
    persist(failure)
    console.error('[Wework] Local workspace catalog failed', JSON.stringify(failure))
    throw error
  }
}
