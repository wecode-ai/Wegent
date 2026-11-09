import { pierreDark, pierreLight, toCSS } from '@pierre/highlights/themes'
import { PIERRE_SYNTAX_COLORS } from '../theme/codeSyntax'

const workbenchSyntaxCSS = Object.entries(PIERRE_SYNTAX_COLORS)
  .map(
    ([category, color]) =>
      `--hls-${category.replace(/[._]/g, '-')}: rgb(var(--color-syntax-${color}));`
  )
  .join('\n')

/** The same Pierre palettes used by file, diff, and editable code surfaces. */
export const codeThemeCSS = `
  .pierre-code-block { ${toCSS(pierreLight)} }
  [data-theme='dark'] .pierre-code-block:not([data-theme='light']),
  .pierre-code-block[data-theme='dark'] { ${toCSS(pierreDark)} }
  html[data-appearance-theme][data-theme] .pierre-code-block {
    --hls-foreground: rgb(var(--color-text-primary));
    --hls-background: rgb(var(--color-code-bg));
    --hls-diff-plus: rgb(var(--color-diff-added));
    --hls-diff-minus: rgb(var(--color-diff-removed));
    --hls-link-text: rgb(var(--color-link));
    --hls-link-uri: rgb(var(--color-link));
    --hls-embedded: rgb(var(--color-text-primary));
    --hls-emphasis: rgb(var(--color-text-primary));
    --hls-emphasis-strong: rgb(var(--color-text-primary));
    --hls-primary: rgb(var(--color-text-primary));
    ${workbenchSyntaxCSS}
  }
`
