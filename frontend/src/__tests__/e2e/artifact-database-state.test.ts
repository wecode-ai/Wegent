/** @jest-environment node */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { artifactDatabaseState } from '../../../e2e/utils/artifact-database-state'

jest.mock('node:child_process', () => ({ execFile: jest.fn() }))
jest.mock('node:util', () => ({ promisify: jest.fn(() => jest.fn()) }))

const execute = jest.mocked(promisify).mock.results[0].value as jest.Mock
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
      '--no-editable',
      '--no-env-file',
      'python',
      expect.stringMatching(/backend\/tests\/e2e\/artifact_task_state\.py$/),
    ])
    expect(options.env.UV_NO_SYNC).toBe('0')
    expect(options.env.DATABASE_URL).toBe(process.env.DATABASE_URL)
    expect(JSON.parse(options.env.WEGENT_ARTIFACT_E2E_REQUEST)).toEqual(identity)
    expect(process.env.UV_NO_SYNC).toBe('1')
  })

  it('requires an explicit database instead of loading a service env file', async () => {
    delete process.env.DATABASE_URL
    await expect(artifactDatabaseState(identity)).rejects.toThrow('isolated service DATABASE_URL')
    expect(execute).not.toHaveBeenCalled()
  })

  it('surfaces helper failures rather than returning fabricated state', async () => {
    execute.mockRejectedValue(new Error('database helper failed'))
    await expect(artifactDatabaseState(identity)).rejects.toThrow('database helper failed')
  })
})
