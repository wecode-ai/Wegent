/** @jest-environment node */

import { execFile } from 'node:child_process'
import { delimiter, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  artifactDatabaseState,
  prepareArtifactDatabaseState,
} from '../../../e2e/utils/artifact-database-state'

jest.mock('node:child_process', () => ({ execFile: jest.fn() }))
jest.mock('node:util', () => ({ promisify: jest.fn(() => jest.fn()) }))

const execute = jest.mocked(promisify).mock.results[0].value as jest.Mock
/** The checkout root, so the assertion also holds inside a git worktree. */
const repoRoot = resolve(__dirname, '..', '..', '..', '..')
const identity = {
  operation: 'inspect' as const,
  task_id: 29,
  context_id: 35,
  user_id: 1,
  expected_device_id: 'e2e-artifact-owned',
}

describe('artifact database process isolation', () => {
  const previous = { ...process.env }

  beforeEach(() => {
    process.env.DATABASE_URL = 'mysql+pymysql://test-only@localhost/wegent_test'
    process.env.UV_PROJECT_ENVIRONMENT = '/backend/service/.venv'
    process.env.UV_NO_SYNC = '1'
    process.env.UV_NO_EDITABLE = '1'
    process.env.PYTHONPATH = '/existing/source'
    execute.mockResolvedValue({ stdout: '{"binary_size":0}' })
  })

  afterEach(() => {
    process.env = { ...previous }
    execute.mockReset()
  })

  it('isolates Python from the mounted service environment and freezes the lockfile', async () => {
    await expect(artifactDatabaseState(identity)).resolves.toEqual({ binary_size: 0 })

    expect(promisify).toHaveBeenCalledWith(execFile)
    const [command, args, options] = execute.mock.calls[0]
    expect(command).toBe('uv')
    expect(args).toEqual([
      'run',
      '--isolated',
      '--frozen',
      '--no-env-file',
      'python',
      expect.stringMatching(/backend\/tests\/e2e\/artifact_task_state\.py$/),
    ])
    expect(options.env.UV_NO_SYNC).toBe('0')
    expect(options.timeout).toBe(30_000)
    expect(options.env.UV_NO_EDITABLE).toBe('0')
    const paths = options.env.PYTHONPATH.split(delimiter)
    expect(paths[0]).toBe(join(repoRoot, 'backend'))
    expect(paths[1]).toBe(repoRoot)
    expect(paths[2]).toBe('/existing/source')
    expect(options.env.DATABASE_URL).toBe(process.env.DATABASE_URL)
    expect(JSON.parse(options.env.WEGENT_ARTIFACT_E2E_REQUEST)).toEqual(identity)
    expect(process.env.UV_NO_SYNC).toBe('1')
    expect(process.env.UV_NO_EDITABLE).toBe('1')
  })

  it('prepares real imports before device turns with a separate bounded installation step', async () => {
    await prepareArtifactDatabaseState()
    const [command, args, options] = execute.mock.calls[0]
    expect(command).toBe('uv')
    expect(args).toEqual([
      'run',
      '--isolated',
      '--frozen',
      '--no-env-file',
      'python',
      '-c',
      'from app.db.session import SessionLocal',
    ])
    expect(options.timeout).toBe(300_000)
    expect(options.env.WEGENT_ARTIFACT_E2E_REQUEST).toBeUndefined()
  })

  it('requires an explicit database instead of loading a service env file', async () => {
    delete process.env.DATABASE_URL
    await expect(artifactDatabaseState(identity)).rejects.toThrow('isolated service DATABASE_URL')
    expect(execute).not.toHaveBeenCalled()
  })

  it('provides Backend sources when the browser container has no PYTHONPATH', async () => {
    delete process.env.PYTHONPATH
    await artifactDatabaseState(identity)
    const paths = execute.mock.calls[0][2].env.PYTHONPATH.split(delimiter)
    expect(paths).toHaveLength(2)
    expect(paths[0]).toBe(join(repoRoot, 'backend'))
    expect(paths[1]).toBe(repoRoot)
  })

  it('surfaces helper failures rather than returning fabricated state', async () => {
    execute.mockRejectedValue(new Error('database helper failed'))
    await expect(artifactDatabaseState(identity)).rejects.toThrow('database helper failed')
  })
})
