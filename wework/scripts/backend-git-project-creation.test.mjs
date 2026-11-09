// @vitest-environment node

import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { verifyBackendGitProjectCreation } from '../e2e/desktop/modules/backend-git-project-creation.mjs'

const mocks = vi.hoisted(() => ({
  fetchJson: vi.fn(),
  readFile: vi.fn(),
  runChecked: vi.fn(),
  rm: vi.fn(),
  fetch: vi.fn(),
  requestExecutor: vi.fn(),
}))

vi.mock('node:fs/promises', () => ({ rm: mocks.rm }))
vi.mock('../e2e/desktop/modules/shared.mjs', async () => ({
  assert: (await import('node:assert/strict')).default,
  fetchJson: mocks.fetchJson,
  readFile: mocks.readFile,
  runChecked: mocks.runChecked,
}))
vi.mock('../e2e/desktop/modules/executor-rpc.mjs', () => ({
  requestExecutor: mocks.requestExecutor,
}))

const cloud = {
  backendUrl: 'https://backend.invalid',
  authToken: 'synthetic-fixture',
  waitForConnectedAppDevice: async () => ({ execution_target_id: 'app-record-42' }),
}
const control = {}
const fixture = { source: '/virtual/source', domain: 'git.invalid' }
let checkoutPath

beforeEach(() => {
  vi.clearAllMocks()
  checkoutPath = 'private-checkout'
  mocks.readFile.mockResolvedValue('# Private Git recovery\n')
  mocks.runChecked.mockResolvedValue(undefined)
  mocks.rm.mockResolvedValue(undefined)
  mocks.fetch.mockResolvedValue({ status: 204 })
  vi.stubGlobal('fetch', mocks.fetch)
  mocks.requestExecutor.mockImplementation(async (_control, _method, params) => {
    const { command_key, args } = params
    const stdout =
      command_key === 'project_workspace_root'
        ? '/virtual/workspace'
        : command_key === 'git_branch'
          ? 'develop'
          : command_key === 'git_remote_url'
            ? fixture.source
            : args[1] === 'user.name'
              ? 'oauth2'
              : 'recovery@example.test'
    return { success: true, stdout }
  })
  mocks.fetchJson.mockImplementation(async url => {
    if (url.endsWith('/git-workspace')) {
      return {
        project: { id: 42 },
        checkout_path: checkoutPath,
        reused_existing_checkout: false,
      }
    }
    return {
      items: [
        {
          id: 42,
          config: {
            workspace: { checkoutPath },
            execution: { deviceId: 'app-record-42' },
          },
        },
      ],
    }
  })
})

afterEach(() => vi.unstubAllGlobals())

test('checks Backend creation at workspace root, persisted path and repo identity', async () => {
  const phase = vi.fn()
  await verifyBackendGitProjectCreation(control, cloud, fixture, phase)
  expect(phase).toHaveBeenCalledWith('git-clone-recovery-backend-project-cwd')
  const creation = mocks.fetchJson.mock.calls.find(([url]) => url.endsWith('/git-workspace'))
  expect(JSON.parse(creation[1].body)).toMatchObject({
    device_id: 'app-record-42',
    client_origin: 'wework',
    git: { url: fixture.source, domain: fixture.domain, branch: 'develop' },
  })
  expect(mocks.readFile).toHaveBeenCalledWith(
    '/virtual/workspace/private-checkout/README.md',
    'utf8'
  )
  expect(mocks.runChecked).toHaveBeenCalledWith('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: '/virtual/workspace/private-checkout',
  })
  const commands = mocks.requestExecutor.mock.calls.map(([, , params]) => params)
  expect(commands.filter(command => command.command_key === 'git_config')).toEqual([
    {
      command_key: 'git_config',
      path: '/virtual/workspace/private-checkout',
      args: ['--get', 'user.name'],
    },
    {
      command_key: 'git_config',
      path: '/virtual/workspace/private-checkout',
      args: ['--get', 'user.email'],
    },
  ])
  expect(mocks.fetch).toHaveBeenCalledWith(
    'https://backend.invalid/api/projects/42?client_origin=wework',
    expect.objectContaining({ method: 'DELETE' })
  )
  expect(mocks.rm).toHaveBeenCalledWith('/virtual/workspace/private-checkout', {
    recursive: true,
    force: true,
  })
})

test('rejects an escaping checkout without removing another directory', async () => {
  checkoutPath = '../outside'
  await expect(verifyBackendGitProjectCreation(control, cloud, fixture, vi.fn())).rejects.toThrow()
  expect(mocks.readFile).not.toHaveBeenCalled()
  expect(mocks.rm).not.toHaveBeenCalled()
  expect(mocks.fetch).toHaveBeenCalledTimes(1)
})

test('preserves missing checkout failure and still cleans up the created project', async () => {
  mocks.readFile.mockRejectedValueOnce(new Error('Checkout missing at workspace root'))
  await expect(verifyBackendGitProjectCreation(control, cloud, fixture, vi.fn())).rejects.toThrow(
    'Checkout missing at workspace root'
  )
  expect(mocks.fetch).toHaveBeenCalledTimes(1)
  expect(mocks.rm).toHaveBeenCalledTimes(1)
})
