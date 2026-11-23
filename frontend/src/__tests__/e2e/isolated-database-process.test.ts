/** @jest-environment node */

import { delimiter, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { runIsolatedDatabasePython } from '../../../e2e/utils/isolated-database-state'

jest.mock('node:child_process', () => ({ execFile: jest.fn() }))
jest.mock('node:util', () => ({ promisify: jest.fn(() => jest.fn()) }))

const repository = resolve(__dirname, '../../../..')
const execute = jest.mocked(promisify).mock.results[0].value as jest.Mock
const identity = { task_id: 29, user_id: 1 }

describe('isolated database process handling', () => {
  const previous = { ...process.env }

  beforeEach(() => {
    process.env.DATABASE_URL = 'mysql+pymysql://test-only@localhost/wegent_test'
    process.env.UV_PROJECT_ENVIRONMENT = '/backend/service/.venv'
    process.env.UV_NO_SYNC = '1'
    process.env.UV_NO_EDITABLE = '1'
    process.env.PYTHONPATH = '/existing/source'
    execute.mockResolvedValue({ stdout: '{}' })
  })

  afterEach(() => {
    process.env = { ...previous }
    execute.mockReset()
  })

  it('runs a fixture in an isolated frozen Python environment', async () => {
    await runIsolatedDatabasePython('tests/e2e_fixture.py', identity)

    const [command, args, options] = execute.mock.calls[0]
    expect(command).toBe('uv')
    expect(args).toEqual([
      'run',
      '--isolated',
      '--frozen',
      '--no-env-file',
      'python',
      'tests/e2e_fixture.py',
    ])
    expect(options.cwd).toBe(join(repository, 'backend'))
    expect(options.timeout).toBe(30_000)
    expect(options.env.UV_NO_SYNC).toBe('0')
    expect(options.env.UV_NO_EDITABLE).toBe('0')
    expect(options.env.PYTHONPATH.split(delimiter)).toEqual([
      join(repository, 'backend'),
      repository,
      '/existing/source',
    ])
    expect(JSON.parse(options.env.WEGENT_ISOLATED_DATABASE_REQUEST)).toEqual(identity)
    expect(process.env.UV_NO_SYNC).toBe('1')
  })

  it('prepares dependencies with a longer bounded installation step', async () => {
    await runIsolatedDatabasePython('-c', undefined, 300_000, 'print("ready")')

    const [, args, options] = execute.mock.calls[0]
    expect(args).toEqual([
      'run',
      '--isolated',
      '--frozen',
      '--no-env-file',
      'python',
      '-c',
      'print("ready")',
    ])
    expect(options.timeout).toBe(300_000)
    expect(options.env.WEGENT_ISOLATED_DATABASE_REQUEST).toBeUndefined()
  })

  it('requires the isolated service database URL', async () => {
    delete process.env.DATABASE_URL
    await expect(runIsolatedDatabasePython('tests/e2e_fixture.py', identity)).rejects.toThrow(
      'isolated service DATABASE_URL'
    )
    expect(execute).not.toHaveBeenCalled()
  })

  it('surfaces fixture failures instead of masking them', async () => {
    execute.mockRejectedValue(new Error('database fixture failed'))
    await expect(runIsolatedDatabasePython('tests/e2e_fixture.py', identity)).rejects.toThrow(
      'database fixture failed'
    )
  })
})
