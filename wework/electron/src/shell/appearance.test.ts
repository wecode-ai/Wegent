import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { describe, expect, test } from 'vitest'

describe('startup document appearance', () => {
  test('applies the persisted palette before styles and replaces it on host updates', async () => {
    const script = await readFile(new URL('./appearance.js', import.meta.url), 'utf8')
    const variables = new Map<string, string>()
    const root = {
      dataset: {} as Record<string, string>,
      style: {
        colorScheme: '',
        setProperty: (name: string, value: string) => variables.set(name, value),
        removeProperty: (name: string) => variables.delete(name),
      },
    }
    type Appearance = { mode: 'light' | 'dark'; themeId: string; variables: Record<string, string> }
    const appearance: Appearance = {
      mode: 'dark',
      themeId: 'tokyo-night',
      variables: { '--color-bg-base': '26 27 38', '--color-text-primary': '192 202 245' },
    }
    const bridge: { onChanged?: (value: Appearance) => void } = {}
    vm.runInNewContext(script, {
      document: { documentElement: root },
      URLSearchParams,
      window: {
        location: { search: `?${new URLSearchParams({ appearance: JSON.stringify(appearance) })}` },
        weworkAppearance: {
          onChanged: (listener: (value: Appearance) => void) => {
            bridge.onChanged = listener
          },
        },
      },
    })

    expect(root.dataset).toMatchObject({ theme: 'dark', appearanceTheme: 'tokyo-night' })
    expect(root.style.colorScheme).toBe('dark')
    expect(variables.get('--color-bg-base')).toBe('26 27 38')
    bridge.onChanged?.({
      mode: 'light',
      themeId: 'github',
      variables: { '--color-bg-base': '255 255 255' },
    })
    expect(root.dataset).toMatchObject({ theme: 'light', appearanceTheme: 'github' })
    expect(variables.has('--color-text-primary')).toBe(false)

    for (const document of ['index.html', 'startup-splash/index.html']) {
      const html = await readFile(new URL(document, import.meta.url), 'utf8')
      expect(html.indexOf('appearance.js')).toBeLessThan(html.indexOf('rel="stylesheet"'))
    }
  })
})
