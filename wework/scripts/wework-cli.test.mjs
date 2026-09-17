import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { parseCliArgs, selectInstance } from '../electron/src/cli/wework-cli.mjs'

const cliPath = resolve(process.cwd(), 'electron/src/cli/wework-cli.mjs')

const mainInstance = {
  instanceId: 'main-a',
  projectRoot: null,
  startedAtUnixMs: 1,
}
const pluginInstance = {
  instanceId: 'plugin-development-b',
  projectRoot: '/workspace/plugin',
  startedAtUnixMs: 2,
}

describe('wework CLI', () => {
  test('parses desktop commands and explicit options', () => {
    expect(
      parseCliArgs([
        'desktop',
        'fill',
        '--instance',
        'plugin-development-b',
        '--selector',
        '[data-testid="composer"]',
        '--value',
        'hello',
      ])
    ).toEqual({
      namespace: 'desktop',
      command: 'fill',
      options: {
        instance: 'plugin-development-b',
        selector: '[data-testid="composer"]',
        value: 'hello',
      },
    })
  })

  test('parses command help without requiring a value', () => {
    expect(parseCliArgs(['desktop', 'click', '--help'])).toEqual({
      namespace: 'desktop',
      command: 'click',
      options: { help: true },
    })
    expect(parseCliArgs(['desktop', 'status', '-h'])).toEqual({
      namespace: 'desktop',
      command: 'status',
      options: { help: true },
    })
  })

  test('prints command help without trying to select an instance', () => {
    const result = spawnSync(process.execPath, [cliPath, 'desktop', 'click', '--help'], {
      encoding: 'utf8',
    })

    expect(result.status).toBe(0)
    expect(result.stderr).toContain('wework desktop click')
    expect(result.stderr).not.toContain('No running Wework desktop instance')
  })

  test('selects the plugin instance from the current project path', () => {
    expect(selectInstance([mainInstance, pluginInstance], {}, '/workspace/plugin/src')).toBe(
      pluginInstance
    )
  })

  test('requires an explicit target when multiple unrelated instances run', () => {
    expect(() =>
      selectInstance([mainInstance, { ...mainInstance, instanceId: 'main-b' }], {}, '/tmp')
    ).toThrow('Multiple Wework instances are running')
  })
})
