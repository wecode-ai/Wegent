import { pierreDark, pierreLight, toCSS } from '@pierre/highlights/themes'

/** The same Pierre palettes used by file, diff, and editable code surfaces. */
export const codeThemeCSS = `
  .pierre-code-block { ${toCSS(pierreLight)} }
  [data-theme='dark'] .pierre-code-block:not([data-theme='light']),
  .pierre-code-block[data-theme='dark'] { ${toCSS(pierreDark)} }
`
