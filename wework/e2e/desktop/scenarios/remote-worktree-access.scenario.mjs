import {
  PERSONAL_MANAGEMENT_METHODS,
  verifyMobileProjectManagement,
} from '../modules/mobile-project-management.mjs'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createDesktopScenario as createTaskAccess } from './remote-task-access.scenario.mjs'
import { until } from '../modules/plugin-regression-fixture.mjs'

const run = promisify(execFile)
const TOGGLE = '[data-testid="remote-task-access-toggle"]'

// Extend the real two-installation checkpoint with worktree reads and Mobile management.
export function createDesktopScenario(options) {
  const existing = createTaskAccess(options)
  let cloud
  let socket
  return {
    ...existing,
    setCloudEnvironment(value) {
      cloud = value
      existing.setCloudEnvironment(value)
    },
    async verify(control) {
      await existing.verify(control)
      const original = await cloud.waitForConnectedAppDevice()
      const route = original.execution_target_id
      const peer = (await cloud.devices()).find(
        device => device.device_type === 'app' && device.id !== original.id
      )
      assert.ok(route)
      assert.ok(peer)
      const sourcePath = join(options.workspacePath, 'remote-worktree-reads')
      await mkdir(sourcePath, { recursive: true })
      const git = (...args) => run('git', ['-C', sourcePath, ...args])
      await git('init', '-b', 'main')
      await writeFile(join(sourcePath, 'README.md'), 'worktree read fixture\n')
      await git('add', '.')
      await git(
        '-c',
        'user.name=Wework Test',
        '-c',
        'user.email=test@example.test',
        'commit',
        '-m',
        'base'
      )
      await git('branch', 'feature/mobile')
      const { io } = createRequire(
        new URL('../../../../packages/chat-core/package.json', import.meta.url)
      )(process.env.WEWORK_E2E_SOCKET_IO_CLIENT || 'socket.io-client')
      socket = io(`${cloud.backendUrl}/wework-runtime`, {
        path: '/socket.io',
        auth: { token: cloud.authToken, client_origin: 'wework' },
        transports: ['websocket'],
        autoConnect: false,
        reconnection: false,
        forceNew: true,
      })
      await new Promise((resolve, reject) => {
        socket.once('connect', resolve)
        socket.once('connect_error', reject)
        socket.connect()
      })
      const rpc = (method, params = {}, device = route) =>
        socket.timeout(options.workbenchReadyTimeoutMs).emitWithAck('runtime:request', {
          type: 'request',
          id: randomUUID(),
          method,
          params,
          device_id: device,
        })
      const inputs = [
        ['runtime.worktrees.capabilities', {}],
        ['runtime.worktrees.preflight', { sourcePath, includeBranches: true }],
      ]
      const denied = async device => {
        for (const [method, input] of [
          ...inputs,
          ...PERSONAL_MANAGEMENT_METHODS.map(method => [method, {}]),
        ]) {
          const result = await rpc(method, input, device)
          assert.equal(result.ok, false, `${method} retained access without local consent`)
          assert.equal(result.error.code, 'remote_control_disabled')
        }
      }
      await denied(route)
      await control.command('navigate', 'body', { value: '/settings/connections' })
      await control.command('waitFor', TOGGLE)
      await control.command('clickWhenEnabled', TOGGLE)
      await until(
        () => cloud.devices(),
        devices =>
          devices.find(device => device.id === original.id)?.runtime_features?.remoteTaskAccess
            ?.enabled === true,
        'Worktree read consent did not reach the inventory',
        options.workbenchReadyTimeoutMs
      )
      for (const [method, input] of inputs) {
        const result = await rpc(method, input)
        assert.equal(result.ok, true, `${method} failed with local consent`)
        assert.equal(result.result.deviceId, route)
        if (method.endsWith('preflight')) {
          assert.equal(result.result.gitRepository, true)
          assert.ok(result.result.branches.includes('feature/mobile'))
          assert.equal(result.result.currentBranch, 'main')
        }
        const endpoint = method.endsWith('capabilities') ? 'capabilities' : 'preflight'
        const response = await fetch(`${cloud.backendUrl}/api/runtime-work/worktrees/${endpoint}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${cloud.authToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ deviceId: route, ...input }),
        })
        assert.equal(response.ok, true, `HTTP worktree ${endpoint} failed`)
        const projected = await response.json()
        assert.equal(projected.deviceId, route)
        if (endpoint === 'preflight') assert.deepEqual(projected.branches, result.result.branches)
      }
      await verifyMobileProjectManagement({
        rpc,
        sourcePath,
        route,
        timeoutMs: options.workbenchReadyTimeoutMs,
      })
      const localWork = JSON.parse(await control.command('getLocalRuntimeWork', 'body'))
      const localTask = (localWork.workspaces ?? [])
        .flatMap(workspace => workspace.tasks ?? [])
        .find(
          task =>
            task.status !== 'archived' &&
            task.workspacePath &&
            (task.taskId ?? task.localTaskId ?? task.id)
        )
      assert.ok(localTask, 'A local task workspace is required for scoped file reads')
      const taskTree = await rpc('runtime.workspace.read', {
        root: localTask.workspacePath,
        path: localTask.workspacePath,
        taskId: localTask.taskId ?? localTask.localTaskId ?? localTask.id,
        commandKey: 'workspace_tree',
      })
      assert.equal(taskTree.ok, true, JSON.stringify(taskTree.error))
      assert.equal(taskTree.result.success, true)
      const fileRead = (commandKey, path = sourcePath, args = []) => ({
        root: sourcePath,
        path,
        commandKey,
        args,
      })
      const tree = await rpc('runtime.workspace.read', fileRead('workspace_tree'))
      assert.equal(tree.ok, true, JSON.stringify(tree.error))
      assert.equal(tree.result.success, true)
      assert.ok(tree.result.stdout.entries.some(entry => entry.name === 'README.md'))
      const text = await rpc(
        'runtime.workspace.read',
        fileRead('workspace_read_text_file', sourcePath, ['README.md'])
      )
      assert.equal(text.ok, true, JSON.stringify(text.error))
      assert.equal(text.result.stdout.content, 'worktree read fixture\n')
      const branch = await rpc('runtime.workspace.read', fileRead('git_branch'))
      assert.equal(branch.ok, true, JSON.stringify(branch.error))
      assert.equal(branch.result.stdout.trim(), 'main')
      const outside = await rpc(
        'runtime.workspace.read',
        fileRead('workspace_tree', options.workspacePath)
      )
      assert.equal(outside.ok, false)
      assert.equal(outside.error.code, 'workspace_access_denied')
      const write = await rpc(
        'runtime.workspace.read',
        fileRead('workspace_write_text_file', sourcePath, ['README.md', 'revision'])
      )
      assert.equal(write.ok, false)
      assert.equal(write.error.code, 'bad_request')
      await denied(peer.execution_target_id)
      const peerFile = await rpc(
        'runtime.workspace.read',
        fileRead('workspace_tree'),
        peer.execution_target_id
      )
      assert.equal(peerFile.ok, false)
      assert.equal(peerFile.error.code, 'remote_control_disabled')
      for (const method of [
        'device.execute_command',
        'runtime.worktrees.settings.update',
        'runtime.worktrees.prepare',
        'runtime.worktrees.delete',
      ]) {
        const result = await rpc(method, {
          sourcePath,
          ...(method === 'device.execute_command'
            ? { command_key: 'git_status_porcelain', cwd: sourcePath }
            : {}),
        })
        assert.equal(result.ok, false)
        assert.equal(result.error.code, 'remote_control_disabled')
      }
      assert.equal((await git('branch', '--show-current')).stdout.trim(), 'main')
      await control.command('clickWhenEnabled', TOGGLE)
      await until(
        () => cloud.devices(),
        devices =>
          devices.find(device => device.id === original.id)?.runtime_features?.remoteTaskAccess
            ?.enabled === false,
        'Worktree read revocation did not reach the inventory',
        options.workbenchReadyTimeoutMs
      )
      await denied(route)
      const revokedFile = await rpc('runtime.workspace.read', fileRead('workspace_tree'))
      assert.equal(revokedFile.ok, false)
      assert.equal(revokedFile.error.code, 'remote_control_disabled')
    },
    async cleanup() {
      socket?.disconnect()
      await existing.cleanup?.()
    },
  }
}
