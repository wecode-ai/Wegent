import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, test, vi } from 'vitest'

describe('startup appearance before first paint', () => {
  test.each([
    { query: '?theme=light', systemDark: true, expected: 'light' },
    { query: '?theme=dark', systemDark: false, expected: 'dark' },
    { query: '', systemDark: true, expected: 'dark' },
    { query: '', systemDark: false, expected: 'light' },
    { query: '?theme=invalid', systemDark: true, expected: 'dark' },
    { query: '?theme=%3Cscript%3E', systemDark: false, expected: 'light' },
  ])('resolves $query with system dark=$systemDark to $expected', async options => {
    const electronRoot =
      basename(process.cwd()) === 'electron' ? process.cwd() : join(process.cwd(), 'electron')
    const script = await readFile(join(electronRoot, 'src/shell/startup-splash/theme.js'), 'utf8')
    const dataset: Record<string, string> = {}
    const matchMedia = vi.fn(() => ({ matches: options.systemDark }))
    runInNewContext(script, {
      URLSearchParams,
      window: { location: { search: options.query }, matchMedia },
      document: { documentElement: { dataset } },
    })
    expect(dataset.theme).toBe(options.expected)
    if (options.query === '?theme=light' || options.query === '?theme=dark') {
      expect(matchMedia).not.toHaveBeenCalled()
    } else {
      expect(matchMedia).toHaveBeenCalledExactlyOnceWith('(prefers-color-scheme: dark)')
    }
  })
})
