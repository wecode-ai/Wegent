import { describe, expect, it } from 'vitest'
import type { LocalDeviceApp } from './runtime-composer-catalog'
import {
  appendInstalledPluginsAsComposerApps,
  composerAppNeedsAuthorization,
  enrichComposerApps,
  isComposerAppSelectable,
  type ComposerInstalledPlugin,
} from './composer-plugin-metadata'

const github: ComposerInstalledPlugin = {
  metadata: { name: 'github', namespace: 'openai-curated-remote' },
  spec: {
    source: { marketplace: 'openai-curated-remote', pluginKey: 'github' },
    enabled: true,
    installState: 'installed',
    displayName: 'GitHub',
    description: 'Use GitHub',
    components: {
      apps: [
        { name: 'GitHub', path: 'github-app' },
        { name: 'GitHub Issues', path: 'github-issues' },
      ],
    },
  },
}
const unlinked: LocalDeviceApp = {
  id: 'github-app',
  name: 'GitHub',
  source: 'codex-app',
  isAccessible: false,
  isEnabled: true,
}
const presentation = () => ({ shortDescription: 'Use GitHub' })
function project(apps: LocalDeviceApp[], plugins = [github]) {
  return appendInstalledPluginsAsComposerApps(
    enrichComposerApps(apps, plugins, presentation),
    plugins,
    presentation
  )
}

describe('composer plugin authorization boundary', () => {
  it('keeps a native package reference selectable without authorizing the app', () => {
    const apps = project([unlinked])
    expect(apps).toHaveLength(1)
    expect(apps[0]).toMatchObject({
      id: 'plugin:github',
      source: 'installed-plugin',
      isAccessible: false,
      skillPath: 'plugin://github@openai-curated-remote',
    })
    expect(composerAppNeedsAuthorization(apps[0])).toBe(true)
    expect(isComposerAppSelectable(apps[0])).toBe(true)
    expect(unlinked.isAccessible).toBe(false)
  })

  it('does not turn an inaccessible or uninstalled app into a selectable tool', () => {
    expect(project([unlinked], [])).toEqual([])
    expect(
      isComposerAppSelectable({ ...unlinked, skillPath: 'plugin://github@openai-curated-remote' })
    ).toBe(false)
  })

  it.each(['disabled', 'uninstalled'] as const)(
    'removes a %s plugin rather than retaining the auth entry',
    state => {
      const plugin = {
        ...github,
        spec: {
          ...github.spec,
          enabled: state !== 'disabled',
          installState: state === 'uninstalled' ? 'not_installed' : 'installed',
        },
      }
      expect(project([unlinked], [plugin])).toEqual([])
    }
  )

  it('deduplicates a package with multiple unlinked dependencies', () => {
    const apps = project([unlinked, { ...unlinked, id: 'github-issues', name: 'GitHub Issues' }])
    expect(apps).toHaveLength(1)
    expect(apps[0].id).toBe('plugin:github')
  })

  it('does not re-enable an explicitly disabled application while projecting its package', () => {
    const app = project([{ ...unlinked, isEnabled: false }])[0]
    expect(app.isEnabled).toBe(false)
    expect(isComposerAppSelectable(app)).toBe(false)
  })

  it('clears the pending indication only after the application source reports access', () => {
    const pending = project([unlinked])[0]
    const authorized = project([{ ...unlinked, isAccessible: true }])[0]
    expect(composerAppNeedsAuthorization(pending)).toBe(true)
    expect(composerAppNeedsAuthorization(authorized)).toBe(false)
    expect(authorized).toMatchObject({ id: 'github-app', source: 'codex-app', isAccessible: true })
    expect(isComposerAppSelectable(authorized)).toBe(true)
    expect(composerAppNeedsAuthorization(project([unlinked])[0])).toBe(true)
  })
})
