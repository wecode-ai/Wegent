import { resolve } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { parseLocalWorkspaceOpenRequest } from './local-workspace-cli.js'

describe('parseLocalWorkspaceOpenRequest', () => {
  afterEach(() => vi.restoreAllMocks())

  test('parses and resolves a workspace request', () => {
    expect(
      parseLocalWorkspaceOpenRequest(
        ['electron', 'app', '--open-workspace', './project', '--workspace-label', 'Demo'],
        '/workspace'
      )
    ).toEqual({
      path: resolve('/workspace/project'),
      label: 'Demo',
    })
  })

  test('ignores invocations without a usable workspace path', () => {
    vi.spyOn(process, 'cwd').mockImplementation(() => {
      throw new Error('Startup directory was removed')
    })
    expect(parseLocalWorkspaceOpenRequest(['electron', 'app'])).toBeNull()
    expect(parseLocalWorkspaceOpenRequest(['electron', 'app', '--open-workspace', ' '])).toBeNull()
  })

  test('opens an absolute workspace without reading the startup directory', () => {
    const path = resolve('/workspace/project')
    vi.spyOn(process, 'cwd').mockImplementation(() => {
      throw new Error('Startup directory was removed')
    })

    expect(
      parseLocalWorkspaceOpenRequest([
        'electron',
        'app',
        '--open-workspace',
        path,
        '--workspace-label',
        'Demo',
      ])
    ).toEqual({ path, label: 'Demo' })
  })

  test('resolves a relative workspace against the startup directory', () => {
    const cwd = resolve('/workspace')
    const path = resolve(cwd, 'project')
    const readCwd = vi.spyOn(process, 'cwd').mockReturnValue(cwd)

    expect(
      parseLocalWorkspaceOpenRequest(['electron', 'app', '--open-workspace', './project'])
    ).toEqual({ path })
    expect(readCwd).toHaveBeenCalledOnce()
  })

  test('resolves a relative workspace against an explicit directory without reading cwd', () => {
    const cwd = resolve('/workspace')
    const path = resolve(cwd, 'project')
    vi.spyOn(process, 'cwd').mockImplementation(() => {
      throw new Error('Startup directory was removed')
    })

    expect(
      parseLocalWorkspaceOpenRequest(['electron', 'app', '--open-workspace', './project'], cwd)
    ).toEqual({ path })
  })

  test('preserves the error when a relative workspace needs a missing startup directory', () => {
    const error = Object.assign(new Error('Startup directory was removed'), { code: 'ENOENT' })
    vi.spyOn(process, 'cwd').mockImplementation(() => {
      throw error
    })

    expect(() =>
      parseLocalWorkspaceOpenRequest(['electron', 'app', '--open-workspace', './project'])
    ).toThrow(error)
  })
})
