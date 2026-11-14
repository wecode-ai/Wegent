import { createCSSVariablesTheme, registerCustomTheme } from '@pierre/diffs'

const mobileLightTheme = createCSSVariablesTheme({
  name: 'wework-mobile-light',
  variablePrefix: '--mobile-code-',
  fontStyle: false,
  variableDefaults: {
    foreground: '#222222',
    background: '#f8f8f8',
    'token-comment': '#267f25',
    'token-string-expression': '#c23134',
    'token-string': '#c23134',
    'token-keyword': '#a32399',
    'token-constant': '#5e8187',
    'token-parameter': '#5e8187',
    'token-function': '#222222',
    'token-punctuation': '#222222',
    'token-link': '#2679c8',
    'token-inserted': '#267f25',
    'token-deleted': '#c23134',
  },
})
mobileLightTheme.type = 'light'
if (mobileLightTheme.zed) {
  mobileLightTheme.zed.appearance = 'light'
  mobileLightTheme.zed.style.syntax = {
    ...mobileLightTheme.zed.style.syntax,
    variable: 'token-parameter',
  }
}
registerCustomTheme(mobileLightTheme.name, async () => mobileLightTheme, 'diffs')
registerCustomTheme(
  mobileLightTheme.name,
  async () => ({
    name: mobileLightTheme.name,
    type: 'light',
    colors: { 'editor.foreground': '#222222', 'editor.background': '#f8f8f8' },
    tokenColors: [
      { scope: ['comment'], settings: { foreground: '#267f25' } },
      { scope: ['keyword', 'storage', 'constant.language'], settings: { foreground: '#a32399' } },
      { scope: ['string'], settings: { foreground: '#c23134' } },
      { scope: ['string.unquoted'], settings: { foreground: '#222222' } },
      { scope: ['variable', 'constant.numeric'], settings: { foreground: '#5e8187' } },
    ],
  }),
  'textmate'
)

export const codeTheme = { light: mobileLightTheme.name, dark: 'github-dark' }

// Keep the virtualizer estimate in sync with the single visual-line row below.
export const codeItemMetrics = { lineHeight: 19.5, spacing: 0, paddingTop: 0, paddingBottom: 0 }
export const codeLayout = { paddingTop: 0, paddingBottom: 80, gap: 8 }

export const codeStyles = `
  :host {
    --diffs-font-size: 13px;
    --diffs-line-height: 15.5px;
    --diffs-font-family: ui-monospace, Menlo, monospace;
    --diffs-gap-block: 0px;
  }
  [data-file] { --diffs-grid-number-column-width: minmax(28px, max-content); }
  [data-line], [data-column-number] { padding-block: 2px; }
  [data-file] [data-line] { padding-inline: 4px; }
  [data-file][data-overflow='wrap'] [data-line] { word-break: break-all; }
  [data-file] [data-gutter] { background: var(--mobile-code-gutter); }
  [data-file] [data-column-number] {
    padding-inline: 6px 4px;
    border-right: 0;
    background: var(--mobile-code-gutter);
    color: var(--mobile-code-number);
    font-size: 13px;
    text-align: left;
  }
  [data-file] [data-line-number-content] { min-width: 0; }
`
