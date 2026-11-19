/** Keep transport metadata only; request headers, queries and bodies are never copied. */
export function recordHttpRequest(request, response, url, requests, metadata = {}) {
  const diagnostic = {
    ...metadata,
    method: request.method ?? 'UNKNOWN',
    pathname: url.pathname,
    startedAtUnixMs: Date.now(),
  }
  requests.push(diagnostic)
  response.once('finish', () => {
    diagnostic.status = response.statusCode
    diagnostic.finishedAtUnixMs = Date.now()
    diagnostic.durationMs = diagnostic.finishedAtUnixMs - diagnostic.startedAtUnixMs
  })
  response.once('close', () => {
    if (!response.writableFinished) {
      diagnostic.aborted = true
      diagnostic.closedAtUnixMs = Date.now()
    }
  })
  return diagnostic
}
