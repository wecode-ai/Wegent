/** Classify failed E2E login responses without recording their bodies or credentials. */
export async function cloudIdentityFailure(response: Response, endpoint: string): Promise<Error> {
  const body = await response.text().catch(() => '')
  const sources = [
    ['dsh-api-proxy', 'Wegent backend is unavailable'],
    ['hybrid-fallback', 'fallback upstream unavailable'],
    ['cloud-login-proxy-fixture', 'The cloud login proxy has no upstream'],
  ] as const
  const source = sources.find(([, marker]) => body.includes(marker))?.[0] ?? 'unclassified'
  const code = body.match(
    /\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|EPIPE)\b/
  )?.[0]
  const url = new URL(endpoint)
  const diagnostic = {
    endpoint: `${url.origin}${url.pathname}`,
    source,
    ...(code ? { code } : {}),
    bodyType: /json/i.test(response.headers.get('content-type') ?? '')
      ? 'json'
      : /html/i.test(response.headers.get('content-type') ?? '')
        ? 'html'
        : 'other',
  }
  return new Error(`E2E cloud identity returned ${response.status}: ${JSON.stringify(diagnostic)}`)
}
