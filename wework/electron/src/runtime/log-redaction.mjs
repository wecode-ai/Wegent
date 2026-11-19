export function redactLog(value) {
  // Other raw authorization schemes may contain quoted parameters and commas.
  return value
    .replace(
      /\b(authorization["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:basic|bearer)\s+[A-Za-z0-9._~+/-]+=*(?=$|[\s,;"'{}])|\[REDACTED\]|[^\r\n]+)/gi,
      (_match, field, credential) => {
        const quote = credential.startsWith('"') ? '"' : credential.startsWith("'") ? "'" : ''
        return `${field}${quote}[REDACTED]${quote}`
      }
    )
    .replace(
      /(["']?(?:access_token|auth_token|api_key|cookie|password|refresh_token|secret|token)["']?\s*[:=]\s*["']?)[^"',\s}]+/gi,
      '$1[REDACTED]'
    )
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
}
