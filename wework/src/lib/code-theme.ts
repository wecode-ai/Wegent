import { createCSSVariablesTheme, registerCustomTheme } from '@pierre/diffs'

// Stable CSS references preserve mounted code views when the palette changes.
export const WEWORK_CODE_THEME = 'wework-semantic'

const variableDefaults = {
  foreground: 'rgb(var(--color-text-primary))',
  background: 'rgb(var(--color-bg-base))',
  'token-keyword': 'rgb(var(--color-syntax-keyword))',
  'token-string': 'rgb(var(--color-syntax-string))',
  'token-string-expression': 'rgb(var(--color-syntax-string))',
  'token-comment': 'rgb(var(--color-syntax-comment))',
  'token-constant': 'rgb(var(--color-syntax-number))',
  'token-parameter': 'rgb(var(--color-syntax-variable))',
  'token-function': 'rgb(var(--color-syntax-function))',
  'token-punctuation': 'rgb(var(--color-syntax-punctuation))',
  'token-link': 'rgb(var(--color-link))',
  'token-inserted': 'rgb(var(--color-diff-added))',
  'token-deleted': 'rgb(var(--color-diff-removed))',
  'token-changed': 'rgb(var(--color-primary))',
  'ansi-green': 'rgb(var(--color-diff-added))',
  'ansi-red': 'rgb(var(--color-diff-removed))',
  'ansi-blue': 'rgb(var(--color-primary))',
}

const theme = createCSSVariablesTheme({
  name: WEWORK_CODE_THEME,
  variablePrefix: '--diffs-',
  variableDefaults,
  fontStyle: false,
})

// Shiki's generic CSS theme groups types with functions and operators with keywords.
// Keep those syntax roles distinct, as they are in the editor and Markdown adapter.
theme.tokenColors = [
  ...(theme.tokenColors ?? []),
  {
    scope: ['entity.name.type', 'entity.other.inherited-class', 'support.type'],
    settings: { foreground: 'rgb(var(--color-syntax-type))' },
  },
  {
    scope: 'keyword.operator',
    settings: { foreground: 'rgb(var(--color-syntax-operator))' },
  },
  {
    scope: ['variable.other.readwrite', 'variable.other.property', 'entity.other.attribute-name'],
    settings: { foreground: 'rgb(var(--color-syntax-variable))' },
  },
]

registerCustomTheme(WEWORK_CODE_THEME, () => Promise.resolve(theme))
