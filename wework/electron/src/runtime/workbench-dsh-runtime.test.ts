import { mkdir, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import {
  injectModelProviderPatch,
  prepareWorkbenchDshLaunch,
  resolveWorkbenchProjectPnpmCommand,
  WORKBENCH_DSH_VERSION,
} from './workbench-dsh-runtime.js'
import { temporaryDirectory } from './test-helpers.js'

describe('workbench DSH runtime', () => {
  test('replaces an empty YAML patch list when injecting the selected model', () => {
    expect(injectModelProviderPatch('[]\n')).toBe(
      [
        '- id: agent-default-model',
        '  config:',
        '    provider: wework-local',
        '    model: wework-selected',
        '',
      ].join('\n')
    )
  })

  test('updates an existing provider and model pair', () => {
    expect(
      injectModelProviderPatch(
        [
          '- id: agent-default-model',
          '  config:',
          '    provider: fixture',
          '    model: fixture-model',
          '',
        ].join('\n')
      )
    ).toBe(
      [
        '- id: agent-default-model',
        '  config:',
        '    provider: wework-local',
        '    model: wework-selected',
        '',
      ].join('\n')
    )
  })

  test('rejects an incomplete provider and model pair', () => {
    expect(() =>
      injectModelProviderPatch('- id: agent-default-model\n  config:\n    provider: fixture\n')
    ).toThrow('Smart app exposes an incomplete provider/model pair')
  })

  test('makes the managed Node executable available to pnpm subprocesses', async () => {
    const root = await temporaryDirectory('workbench-dsh-node-path-')
    const runtimeRoot = join(root.path, 'runtime')
    const packageRoot = join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh')
    const appRoot = join(root.path, 'smart-app', 'profile-bundle')
    const managedNode = join(root.path, 'managed-node', 'bin', 'node')
    const fingerprint = 'a'.repeat(64)
    await mkdir(join(packageRoot, 'lib'), { recursive: true })
    await mkdir(appRoot, { recursive: true })
    await writeFile(
      join(runtimeRoot, 'runtime.json'),
      JSON.stringify({
        dshVersion: WORKBENCH_DSH_VERSION,
        role: 'workbench',
        sourceFingerprint: fingerprint,
      })
    )
    await writeFile(
      join(packageRoot, 'package.json'),
      JSON.stringify({ version: WORKBENCH_DSH_VERSION })
    )
    await writeFile(join(packageRoot, 'lib', 'bin.js'), '')
    await writeFile(join(appRoot, 'package.json'), JSON.stringify({ name: 'profile-bundle' }))
    const run = vi.fn().mockResolvedValue(undefined)

    const launch = await prepareWorkbenchDshLaunch({
      runtimeRoot,
      dataDirectory: join(root.path, 'data'),
      installationId: 'test-app',
      packagePath: join(root.path, 'smart-app'),
      manifest: {
        name: 'test-app',
        displayName: 'Test App',
        version: '1.0.0',
        type: 'deepseek-harness-plugin-bundle',
        description: 'Test app',
        entry: {
          installPackage: 'profile-bundle',
          profile: 'web',
        },
        requirements: {
          dsh: WORKBENCH_DSH_VERSION,
          node: '*',
        },
      },
      environment: {
        PATH: '/usr/bin',
        WEWORK_NODE_PATH: managedNode,
        WEWORK_NODE_RUNTIME_KIND: 'electron',
      },
      port: 3080,
      run,
    })

    expect(launch.environment.PATH?.split(delimiter)).toEqual([
      join(runtimeRoot, 'node_modules', '.bin'),
      dirname(managedNode),
      '/usr/bin',
    ])
    expect(run).toHaveBeenCalledWith(
      managedNode,
      expect.arrayContaining(['--expose-internals']),
      expect.objectContaining({
        env: expect.objectContaining({
          PATH: launch.environment.PATH,
        }),
      })
    )
    await root.remove()
  })

  test('resolves project scripts through the managed Node and runtime-owned pnpm', async () => {
    const root = await temporaryDirectory('workbench-project-command-')
    const runtimeRoot = join(root.path, 'runtime')
    const dshRoot = join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh')
    const pnpmEntry = join(runtimeRoot, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
    const managedNode = join(root.path, 'managed-node', 'bin', 'node')
    await mkdir(join(dshRoot, 'lib'), { recursive: true })
    await mkdir(dirname(pnpmEntry), { recursive: true })
    await writeFile(
      join(runtimeRoot, 'runtime.json'),
      JSON.stringify({
        dshVersion: WORKBENCH_DSH_VERSION,
        role: 'workbench',
        sourceFingerprint: 'a'.repeat(64),
      })
    )
    await writeFile(
      join(dshRoot, 'package.json'),
      JSON.stringify({ version: WORKBENCH_DSH_VERSION })
    )
    await writeFile(join(dshRoot, 'lib', 'bin.js'), '')
    await writeFile(pnpmEntry, '')

    const command = await resolveWorkbenchProjectPnpmCommand({
      runtimeRoot,
      environment: {
        PATH: '/unmanaged/bin',
        WEWORK_NODE_PATH: managedNode,
        WEWORK_NODE_RUNTIME_KIND: 'configured',
      },
    })

    expect(command).toEqual({
      command: managedNode,
      argsPrefix: [pnpmEntry],
      environment: expect.objectContaining({
        PATH: [
          join(runtimeRoot, 'node_modules', '.bin'),
          dirname(managedNode),
          '/unmanaged/bin',
        ].join(delimiter),
      }),
    })
    await root.remove()
  })
})
