import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { describe, expect, test } from 'vitest'

describe('startup splash native drag layout', () => {
  test('keeps the full-window animation behind a drag stage and separate interactive footer', async () => {
    const electronRoot =
      basename(process.cwd()) === 'electron' ? process.cwd() : join(process.cwd(), 'electron')
    const asset = (name: string) =>
      readFile(join(electronRoot, 'src', 'shell', 'startup-splash', name), 'utf8')
    const [html, css] = await Promise.all([asset('index.html'), asset('styles.css')])
    const rules = (selector: string) =>
      css.match(new RegExp(`${selector.replaceAll('.', '\\.')}\\s*\\{([^}]+)\\}`))?.[1]
    const stage = rules('.startup-stage')
    const drag = rules('.startup-window-drag-region')
    const footer = rules('.startup-status')

    expect(stage).toContain('display: grid')
    expect(stage).toContain('grid-template-rows: minmax(0, 1fr) auto')
    expect(drag).toContain('grid-row: 1')
    expect(drag).toContain('-webkit-app-region: drag')
    expect(footer).toContain('grid-row: 2')
    expect(footer).toContain('position: relative')
    expect(footer).toContain('-webkit-app-region: no-drag')
    expect(footer).toContain('overflow-y: auto')
    expect(footer).toContain('width: 100%')
    expect(footer).not.toContain('max-width:')
    expect(footer).not.toContain('margin-inline:')
    expect(footer).toContain('max(28px, calc((100% - 48rem) / 2 + 28px))')
    expect(css).toMatch(/\.startup-brand\s*\{[^}]*pointer-events:\s*none/)
    expect(css).toMatch(
      /\.startup-hero,\s*\.startup-brand\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0/
    )
    const dragElement = html.match(/<div\b[^>]*\bid="startup-window-drag-region"[^>]*>/)?.[0]
    expect(dragElement).toContain('aria-hidden="true"')
    expect(html.indexOf('id="startup-window-drag-region"')).toBeLessThan(html.indexOf('<footer'))
    expect(css).toMatch(
      /\.startup-button,\s*\.startup-link-button\s*\{[^}]*-webkit-app-region:\s*no-drag/
    )
  })
})
