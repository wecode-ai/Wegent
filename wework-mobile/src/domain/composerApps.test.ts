import { describe, expect, it } from 'vitest'

import { composerApps, composerLogoUrl, composerMessage } from './composerApps'
import type { RuntimeInstalledPlugin } from '@/types/runtime'

function installedPlugin(
  overrides: Partial<RuntimeInstalledPlugin['spec']> = {}
): RuntimeInstalledPlugin {
  return {
    metadata: { name: 'documents', namespace: 'openai' },
    spec: {
      source: { pluginKey: 'documents', marketplace: 'openai' },
      displayName: 'Documents',
      description: 'Create and edit documents',
      installState: 'installed',
      enabled: true,
      components: { apps: [{ name: 'documents', path: 'documents' }] },
      ...overrides,
    },
  }
}

describe('composerApps', () => {
  it('shows enabled executor apps only when their plugin is installed', () => {
    expect(composerApps([installedPlugin()])).toEqual([
      {
        id: 'documents',
        name: 'Documents',
        description: 'Create and edit documents',
        logoUrl: null,
        reference: '[$Documents](app://documents)',
      },
    ])
  })

  it('keeps installed skill-only plugins selectable', () => {
    const apps = composerApps([
      installedPlugin({
        source: { pluginKey: 'template-creator', marketplace: 'openai' },
        displayName: 'Template Creator',
        components: { skills: [{ name: 'template-creator', path: '/skills/template-creator' }] },
      }),
    ])
    expect(apps[0]?.reference).toBe('[$Template Creator](plugin://template-creator@openai)')
  })

  it('keeps selected plugins structured until the message is submitted', () => {
    const apps = composerApps([installedPlugin()])
    expect(composerMessage('继续处理', apps)).toBe('继续处理 [$Documents](app://documents)')
    expect(composerMessage('', apps)).toBe('[$Documents](app://documents)')
  })

  it('only renders remote and embedded plugin logos', () => {
    expect(composerLogoUrl('https://example.com/logo.png')).toBe('https://example.com/logo.png')
    expect(composerLogoUrl('/local/plugin/logo.png')).toBeNull()
  })
})
