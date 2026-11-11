import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, test } from 'vitest'
import {
  workbenchRequest,
  parseCliArgs,
  smartAppRequest,
  summarizeWorkbenchResult,
  summarizeSmartAppResult,
} from './wework-cli.mjs'

describe('wework CLI entrypoint', () => {
  const cliPath = fileURLToPath(new URL('./wework-cli.mjs', import.meta.url))

  test('executes help through a real symlink instead of silently skipping main', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-cli-entry-'))
    try {
      const physical = join(root, 'physical')
      const alias = join(root, 'alias')
      await mkdir(physical)
      await copyFile(cliPath, join(physical, 'wework-cli.mjs'))
      await symlink(physical, alias, process.platform === 'win32' ? 'junction' : 'dir')

      const result = spawnSync(
        process.execPath,
        [join(alias, 'wework-cli.mjs'), 'workbench', '--help'],
        {
          encoding: 'utf8',
        }
      )
      expect(result.status, result.stderr).toBe(0)
      expect(result.stderr).toContain('wework workbench install --project ABSOLUTE_PATH')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test.each(['unrelated', 'missing', 'nonexistent'])(
    'keeps importing side effect free with an %s argv entry',
    entry => {
      const setup =
        entry === 'missing'
          ? 'process.argv.length = 1'
          : `process.argv[1] = ${JSON.stringify(entry === 'unrelated' ? process.execPath : join(tmpdir(), 'wework-cli-no-such-entry.mjs'))}`
      const result = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `${setup}; await import(${JSON.stringify(pathToFileURL(cliPath).href)}); console.log('imported')`,
        ],
        { encoding: 'utf8' }
      )
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout.trim()).toBe('imported')
      expect(result.stderr).toBe('')
    }
  )
})

describe('wework smart-app CLI', () => {
  test('parses fixed inspect, verify, and pack requests for an absolute linked project root', () => {
    expect(smartAppRequest('inspect', { project: '/workspace/smart-app', format: 'json' })).toEqual(
      { action: 'inspect', projectRoot: resolve('/workspace/smart-app'), format: 'json' }
    )
    expect(smartAppRequest('verify', { project: '/workspace/smart-app' })).toEqual({
      action: 'verify',
      projectRoot: resolve('/workspace/smart-app'),
      format: 'human',
    })
    expect(
      smartAppRequest('pack', {
        project: '/workspace/smart-app',
        output: '/workspace/release.zip',
        instance: 'main',
        format: 'json',
      })
    ).toEqual({
      action: 'pack',
      projectRoot: resolve('/workspace/smart-app'),
      outputPath: resolve('/workspace/release.zip'),
      format: 'json',
    })
  })

  test('rejects relative roots and arbitrary command-style arguments', () => {
    expect(() => smartAppRequest('verify', { project: 'relative/app' })).toThrow(
      '--project must be an absolute path'
    )
    expect(() => smartAppRequest('pack', { project: '/workspace/app' })).toThrow(
      '--output is required for smart-app pack'
    )
    expect(() => smartAppRequest('run', { project: '/workspace/app' })).toThrow(
      'Unknown smart-app command'
    )
    expect(() => smartAppRequest('verify', { project: '/workspace/app', argv: 'node' })).toThrow(
      'Unknown smart-app option'
    )
  })

  test('parses generic CLI options without exposing desktop tokens in human summaries', () => {
    expect(parseCliArgs(['smart-app', 'verify', '--project', '/workspace/app'])).toEqual({
      namespace: 'smart-app',
      command: 'verify',
      options: { project: '/workspace/app' },
    })
    expect(
      summarizeSmartAppResult({
        status: 'failed',
        stages: [{ stage: 'runtime', status: 'failed' }],
        issues: [{ code: 'SA-RUNTIME-START', file: null }],
        token: 'must-not-leak',
      })
    ).toBe('Smart App verification: failed\nRuntime: failed\nSA-RUNTIME-START')
  })
})

describe('wework workbench CLI', () => {
  test('builds installation and per-app lifecycle requests', () => {
    expect(
      workbenchRequest('create', {
        project: '/workspace/todo',
        name: 'todo',
        'display-name': ' Todo ',
        flavor: 'lightweight',
      })
    ).toEqual({
      action: 'create',
      projectPath: resolve('/workspace/todo'),
      name: 'todo',
      displayName: 'Todo',
      flavor: 'lightweight',
      format: 'human',
    })
    expect(workbenchRequest('install', { project: '/workspace/todo', format: 'json' })).toEqual({
      action: 'install',
      projectPath: resolve('/workspace/todo'),
      format: 'json',
    })
    for (const action of ['list', 'create-todo']) {
      expect(workbenchRequest(action, {})).toEqual({ action, format: 'human' })
    }
    for (const action of ['launch', 'hide', 'stop', 'remove', 'shortcut']) {
      expect(workbenchRequest(action, { id: 'todo', instance: 'main' })).toEqual({
        action,
        id: 'todo',
        format: 'human',
      })
    }
    expect(
      workbenchRequest('set-shortcut', { id: 'todo', accelerator: 'CommandOrControl+Shift+T' })
    ).toEqual({
      action: 'set-shortcut',
      id: 'todo',
      accelerator: 'CommandOrControl+Shift+T',
      format: 'human',
    })
    expect(workbenchRequest('set-shortcut', { id: 'todo', clear: 'true' })).toEqual({
      action: 'set-shortcut',
      id: 'todo',
      accelerator: null,
      format: 'human',
    })
  })

  test.each([
    ['run', {}, 'Unknown workbench command'],
    ['install', { project: 'relative' }, 'absolute path'],
    ['list', { project: '/workspace' }, 'Unknown workbench option'],
    ['list', { format: 'yaml' }, '--format'],
    ['launch', {}, 'valid workbench installation ID'],
    ['launch', { id: '../escape' }, 'valid workbench installation ID'],
    ['launch', { id: 'todo', argv: 'node' }, 'Unknown workbench option'],
    ['set-shortcut', { id: 'todo' }, 'Provide either'],
    ['set-shortcut', { id: 'todo', accelerator: '  ' }, 'Provide either'],
    ['set-shortcut', { id: 'todo', clear: 'yes' }, '--clear'],
    ['set-shortcut', { id: 'todo', clear: 'true', accelerator: 'Alt+T' }, 'Provide either'],
    ['launch', { id: 'todo', presentation: 'popup' }, '--presentation'],
    ['configure', { id: 'todo' }, 'Provide --presentation, --resident or --background'],
    ['configure', { id: 'todo', resident: 'yes' }, '--resident'],
    ['configure', { id: 'todo', background: 'yes' }, '--background'],
    [
      'create',
      { project: '/workspace/app', name: 'todo', 'display-name': 'Todo', flavor: 'other' },
      '--flavor',
    ],
    [
      'create',
      { project: '/workspace/app', name: '../todo', 'display-name': 'Todo', flavor: 'lightweight' },
      '--name',
    ],
  ])('rejects malformed %s requests %#', (action, options, message) => {
    expect(() => workbenchRequest(action, options)).toThrow(message)
  })

  test('reports cancellation and distinguishes background apps from stopped apps', () => {
    expect(summarizeWorkbenchResult(null)).toBe('Workbench installation cancelled.')
    expect(summarizeWorkbenchResult([])).toBe('No workbenches installed.')
    expect(
      summarizeWorkbenchResult([
        { id: 'todo', manifest: { displayName: 'Todo' }, state: 'running', visible: false },
        { id: 'notes', manifest: { displayName: 'Notes' }, state: 'installed', visible: false },
      ])
    ).toBe('todo\tTodo\tbackground\nnotes\tNotes\tinstalled')
    expect(summarizeWorkbenchResult('/Desktop/Todo.webloc')).toBe('/Desktop/Todo.webloc')
  })

  test('keeps presentation and background preferences independent of installation type', () => {
    expect(workbenchRequest('launch', { id: 'market-12', presentation: 'window' })).toEqual({
      action: 'launch',
      id: 'market-12',
      presentation: 'window',
      format: 'human',
    })
    expect(
      workbenchRequest('configure', { id: 'managed_ab-12', presentation: 'tab', resident: 'false' })
    ).toEqual({
      action: 'configure',
      id: 'managed_ab-12',
      presentation: 'tab',
      resident: false,
      format: 'human',
    })
  })
})
