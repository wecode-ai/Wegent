import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  buildDevInstanceIdentity,
  findPersistedRuntimeTaskTitle,
  resolveDevInstanceIdentity,
  resolveDevTaskTitle,
} from './resolve-dev-instance-identity.mjs'

const cleanupPaths = []

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

describe('resolve development instance identity', () => {
  test('uses and truncates the task title inherited by the current task shell', async () => {
    const identity = await resolveDevInstanceIdentity(
      { WEWORK_PARENT_TITLE: ' 本地 测试 app 的时候 如果有多个的话 不知道 哪个app ' },
      {
        branch: '',
        workspacePath: '/tmp/worktrees/runtime-527542697/Wgent-subscriptions',
      }
    )

    expect(identity).toMatchObject({
      dockTitle: '本地 测试 app 的时候 如果有多… · 5275',
      executableName: '本地 测试 app 的时候 如果有多… · 5275',
      instanceLabel: '527542697',
      parentTitle: '本地 测试 app 的时候 如果有多个的话 不知道 哪个app',
      title: '本地 测试 app 的时候 如果有多…',
    })
  })

  test('falls back to the persisted task matching the runtime worktree', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-dev-task-index-'))
    cleanupPaths.push(directory)
    const runtimeIndexPath = join(directory, 'index.json')
    const workspacePath = '/tmp/worktrees/runtime-527542697/Wgent-subscriptions'
    const index = {
      tasks: {
        'runtime-527542697': {
          local_task_id: 'runtime-527542697',
          workspace_path: workspacePath,
          title: 'Persisted task title',
          archived: false,
        },
      },
    }
    await writeFile(runtimeIndexPath, JSON.stringify(index))

    expect(findPersistedRuntimeTaskTitle(index, workspacePath)).toBe('Persisted task title')
    await expect(
      resolveDevTaskTitle(
        {},
        {
          runtimeIndexPath,
          workspacePath,
        }
      )
    ).resolves.toBe('Persisted task title')
  })

  test('uses project and branch for a regular checkout', () => {
    expect(
      buildDevInstanceIdentity({
        branch: 'fix/subscription-market',
        workspacePath: '/Users/dev/github/Wegent',
      })
    ).toMatchObject({
      instanceLabel: expect.stringMatching(/^[a-f0-9]{12}$/),
      title: 'Wegent · fix/subscription-market',
    })
  })

  test('uses only the project name for a detached regular checkout', () => {
    expect(
      buildDevInstanceIdentity({
        workspacePath: '/Users/dev/github/Wegent',
      }).title
    ).toBe('Wegent')
  })

  test('does not use archived or unrelated persisted tasks', () => {
    const index = {
      tasks: {
        'runtime-527542697': {
          status: 'archived',
          title: 'Legacy archived task',
        },
      },
    }

    expect(
      findPersistedRuntimeTaskTitle(index, '/tmp/worktrees/runtime-527542697/Wegent')
    ).toBeNull()
    index.tasks['runtime-527542697'] = {
      archived: true,
      title: 'Archived task',
    }
    expect(
      findPersistedRuntimeTaskTitle(index, '/tmp/worktrees/runtime-527542697/Wegent')
    ).toBeNull()
    expect(findPersistedRuntimeTaskTitle(index, '/Users/dev/github/Wegent')).toBeNull()
  })

  test('normalizes unsafe executable-name characters', () => {
    expect(
      buildDevInstanceIdentity({
        branch: 'fix/menu:label',
        workspacePath: '/Users/dev/github/Wegent',
      }).executableName
    ).toMatch(/^Wegent · fix-menu-label · [a-f0-9]{4}$/)
  })
})
