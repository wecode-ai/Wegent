import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { CoreDshPluginManager, parseBlockedBuildMatcher } from './core-dsh-plugin-manager.js'
import { temporaryDirectory } from './test-helpers.js'

describe('CoreDshPluginManager', () => {
  test('preserves disabled plugins and bundle order across unrelated updates', async () => {
    const fixture = await createFixture()
    const manager = fixture.manager()

    await manager.setEnabled('dsh-alpha', false)
    await manager.update('dsh-beta')
    expect(await fixture.userBundles()).toEqual(['dsh-beta'])

    await manager.setEnabled('dsh-alpha', true)
    expect(await fixture.userBundles()).toEqual(['dsh-alpha', 'dsh-beta'])

    const plugins = await manager.list()
    expect(plugins.find(plugin => plugin.name === 'dsh-alpha')).toMatchObject({
      enabled: true,
      immutable: false,
      canToggle: true,
    })
    expect(plugins.some(plugin => plugin.name === 'plain-runtime-library')).toBe(false)
    await fixture.remove()
  })

  test('rejects non-bundle packages and restores the profile manifest', async () => {
    const fixture = await createFixture({
      runCommand: async (_command, args) => {
        if (!args.includes('add')) return { stdout: '', stderr: '' }
        const manifest = await fixture.manifest()
        manifest.dependencies['plain-library'] = '1.0.0'
        await fixture.writeManifest(manifest)
        await fixture.writePackage('plain-library', {
          name: 'plain-library',
          version: '1.0.0',
        })
        return { stdout: '', stderr: '' }
      },
    })
    const before = await fixture.manifest()

    await expect(fixture.manager().install('plain-library')).rejects.toThrow(
      'does not declare dsh.bundle.patch'
    )
    expect(await fixture.manifest()).toEqual(before)
    await fixture.remove()
  })

  test('protects built-in plugins from mutation', async () => {
    const fixture = await createFixture()
    await expect(fixture.manager().setEnabled('@wegent/dsh-app-wework', false)).rejects.toThrow(
      'built-in Core DSH plugin'
    )
    await fixture.remove()
  })

  test('rejects relative local paths before invoking pnpm', async () => {
    const runCommand = vi.fn(async () => ({ stdout: '', stderr: '' }))
    const fixture = await createFixture({ runCommand })
    await expect(fixture.manager().install('../plugin')).rejects.toThrow('absolute local directory')
    expect(runCommand).not.toHaveBeenCalled()
    await fixture.remove()
  })

  test('runs pnpm from the profile and validates DSH from the runtime root', async () => {
    const runCommand = vi.fn(async () => ({ stdout: '', stderr: '' }))
    const fixture = await createFixture({ runCommand })

    await fixture.manager().update('dsh-alpha')

    const pnpmCalls = runCommand.mock.calls.filter(([, args]) => args.includes('update'))
    expect(pnpmCalls).toHaveLength(1)
    expect(pnpmCalls[0]?.[2]?.cwd).toBe(fixture.profileRoot)
    const preflightCall = runCommand.mock.calls.find(([, args]) => args.includes('--dump-config'))
    expect(preflightCall?.[2]?.cwd).toBe(fixture.runtimeRoot)
    await fixture.remove()
  })

  test('parses only the exact pnpm git build matcher', () => {
    expect(
      parseBlockedBuildMatcher(
        'ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED\nallowBuilds:\n  "codeload.github.com/o/p/tar.gz/a": true\n'
      )
    ).toBe('codeload.github.com/o/p/tar.gz/a')
    expect(parseBlockedBuildMatcher('allowBuilds:\n  package: true')).toBeNull()
  })
})

async function createFixture(
  options: {
    runCommand?: (
      command: string,
      args: string[],
      options: { cwd: string; env: NodeJS.ProcessEnv }
    ) => Promise<{ stdout: string; stderr: string }>
  } = {}
) {
  const root = await temporaryDirectory('core-dsh-plugins-')
  const dshHome = join(root.path, 'home')
  const runtimeRoot = join(root.path, 'runtime')
  const profileRoot = join(dshHome, 'profiles', 'wework-core')
  await mkdir(profileRoot, { recursive: true })
  await mkdir(join(runtimeRoot, 'node_modules', 'pnpm', 'bin'), { recursive: true })
  await writeFile(join(runtimeRoot, 'dsh.js'), '')
  await writeFile(join(runtimeRoot, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'), '')
  const manifest = {
    dependencies: {
      '@wegent/dsh-app-wework': 'file:/runtime/app',
      'dsh-alpha': '1.0.0',
      'dsh-beta': '1.0.0',
      'plain-runtime-library': '1.0.0',
    } as Record<string, string>,
    dsh: {
      profile: {
        bundles: ['@wegent/dsh-app-wework', 'dsh-alpha', 'dsh-beta'],
      },
    },
  }
  await writeJson(join(profileRoot, 'package.json'), manifest)
  await writeFile(join(profileRoot, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nallowBuilds:\n')

  const writePackage = async (name: string, value: Record<string, unknown>) => {
    const packageRoot = join(profileRoot, 'node_modules', ...name.split('/'))
    await mkdir(packageRoot, { recursive: true })
    await writeJson(join(packageRoot, 'package.json'), value)
    if (
      value.dsh &&
      typeof value.dsh === 'object' &&
      (value.dsh as { bundle?: { patch?: string } }).bundle?.patch
    ) {
      await writeFile(join(packageRoot, 'cordis.patch.yml'), '[]\n')
    }
  }
  await writePackage('@wegent/dsh-app-wework', {
    name: '@wegent/dsh-app-wework',
    version: '1.0.0',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })
  await writePackage('dsh-alpha', {
    name: 'dsh-alpha',
    displayName: 'Alpha',
    version: '1.0.0',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })
  await writePackage('dsh-beta', {
    name: 'dsh-beta',
    displayName: 'Beta',
    version: '1.0.0',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })
  await writePackage('plain-runtime-library', {
    name: 'plain-runtime-library',
    version: '1.0.0',
  })

  const fixture = {
    manager: () =>
      new CoreDshPluginManager({
        dshHome,
        runtimeRoot,
        dshEntry: join(runtimeRoot, 'dsh.js'),
        nodeCommand: process.execPath,
        environment: {},
        runCommand:
          options.runCommand ??
          (async () => ({
            stdout: '',
            stderr: '',
          })),
      }),
    manifest: () =>
      readFile(join(profileRoot, 'package.json'), 'utf8').then(
        value => JSON.parse(value) as typeof manifest
      ),
    writeManifest: (value: typeof manifest) => writeJson(join(profileRoot, 'package.json'), value),
    writePackage,
    profileRoot,
    runtimeRoot,
    userBundles: async () =>
      (await fixture.manifest()).dsh.profile.bundles.filter(
        name => name !== '@wegent/dsh-app-wework'
      ),
    remove: root.remove,
  }
  return fixture
}

function writeJson(path: string, value: unknown): Promise<void> {
  return writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}
