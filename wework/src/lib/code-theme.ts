import { createCSSVariablesTheme, registerCustomTheme } from '@pierre/diffs'
import { PIERRE_SYNTAX_COLORS, SYNTAX_COLOR_NAMES } from '@wegent/collaboration/theme'

// Stable CSS references preserve mounted code views when the palette changes.
export const WEWORK_CODE_THEME = 'wework-semantic'

const variableDefaults = {
  ...Object.fromEntries(
    SYNTAX_COLOR_NAMES.map(color => [`token-${color}`, `rgb(var(--color-syntax-${color}))`])
  ),
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

// The upstream Highlights backend uses Zed syntax categories.
theme.zed!.style.syntax = {
  ...theme.zed!.style.syntax,
  ...Object.fromEntries(
    Object.entries(PIERRE_SYNTAX_COLORS).map(([category, color]) => [category, `token-${color}`])
  ),
}

registerCustomTheme(WEWORK_CODE_THEME, () => Promise.resolve(theme), 'diffs')
