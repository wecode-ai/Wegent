import { codeToTokens, isSupportedLanguage, type Theme } from '@pierre/highlights'

export interface HighlightedCode {
  code: string
  html: string
}

const theme: Theme = {
  name: 'code-scopes',
  appearance: 'dark',
  cssVariables: true,
  style: {},
}

export function highlightCode(code: string, language: string): HighlightedCode {
  const lang = language === 'shell' ? 'bash' : language
  if (!isSupportedLanguage(lang)) return { code, html: escapeHtml(code) }
  const { tokens } = codeToTokens(code, { lang, theme })
  const parts: string[] = []
  let offset = 0
  for (const line of tokens) {
    for (const token of line) {
      parts.push(escapeHtml(code.slice(offset, token.offset)))
      const scope = token.color?.match(/^var\(--hls-([a-z-]+)\)$/)?.[1]
      const content = escapeHtml(token.content)
      parts.push(
        scope
          ? '<span data-syntax-token="' +
              scope +
              '" style="color:var(--hls-' +
              scope +
              ')">' +
              content +
              '</span>'
          : content
      )
      offset = token.offset + token.content.length
    }
  }
  parts.push(escapeHtml(code.slice(offset)))
  return { code, html: parts.join('') }
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"'\r]/g,
    character =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#x27;',
        '\r': '&#13;',
      })[character]!
  )
}
