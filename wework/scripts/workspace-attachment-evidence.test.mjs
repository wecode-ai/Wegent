import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import * as filesystem from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { createCloudAttachmentVerification } from '../e2e/desktop/modules/cloud-attachment-flow.mjs'
import {
  CLOUD_DEVICE_ID,
  DEFAULT_MODEL_LABEL,
  MODEL_PROVIDER_ID,
} from '../e2e/desktop/modules/shared.mjs'

import {
  assertCloudAttachmentProjectSelection,
  assertRuntimeTaskAttachments,
  findOwnedRuntimeProject,
  findOwnedRuntimeTask,
} from '../e2e/desktop/modules/workspace-attachment-evidence.mjs'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal()
  const operations = {
    readdir: vi.fn(actual.readdir),
    readFile: vi.fn(actual.readFile),
    writeFile: vi.fn(actual.writeFile),
  }
  return {
    ...actual,
    ...operations,
    // Vite's jsdom import interop reads named Node imports from the default export.
    default: { ...actual.default, ...operations },
  }
})

const deviceId = 'cloud-device'
const filename = 'same-name-attachment.png'
const image = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAIAAAACUFjqAAAAEklEQVR4nGP4z8CAB+GTG8HSALfKY52fTcuYAAAAAElFTkSuQmCC',
  'base64'
)
const taskIds = ['runtime-first', 'runtime-second']
const directories = []

async function attachmentRoot() {
  const directory = await mkdtemp(join(tmpdir(), 'wework-attachment-evidence-'))
  directories.push(directory)
  return directory
}

async function writeAttachment(root, taskId, bytes = image) {
  const directory = join(root, taskId, 'attachments', 'turn-1')
  await mkdir(directory, { recursive: true })
  const path = join(directory, filename)
  await writeFile(path, bytes)
  return path
}

afterEach(async () => {
  vi.mocked(filesystem.readdir).mockReset()
  vi.mocked(filesystem.readFile).mockReset()
  vi.mocked(filesystem.writeFile).mockReset()
  vi.useRealTimers()
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true })))
})

function fileVerification(root) {
  return createCloudAttachmentVerification({
    cloudEnvironment: { runtimeWorkspaceRoot: root },
  })
}

function observe(promise) {
  return promise.then(
    value => ({ value }),
    error => ({ error })
  )
}

describe('cloud attachment filesystem deadline', () => {
  test.each(['readdir', 'readFile', 'writeFile'])(
    'bounds an unresponsive %s during file verification and evidence writing',
    async operation => {
      const root = await attachmentRoot()
      await Promise.all(taskIds.map(taskId => writeAttachment(root, taskId)))
      vi.useFakeTimers()
      vi.setSystemTime(0)
      let reachedOperation
      const operationStarted = new Promise(resolve => {
        reachedOperation = resolve
      })
      vi.spyOn(filesystem, operation).mockImplementation(() => {
        reachedOperation()
        return new Promise(() => {})
      })
      const result = observe(
        fileVerification(root).verifyTaskAttachments(taskIds.map(taskId => ({ taskId })))
      )
      await operationStarted

      await vi.advanceTimersByTimeAsync(10_000)
      const outcome = await Promise.race([result, Promise.resolve({ pending: true })])
      expect(outcome.error).toBeInstanceOf(Error)
      expect(outcome.error.message).toMatch(/attachment verification.*within 10000ms/)
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  test.each([10_000, 10_001])('rejects evidence writing completed at %sms', async elapsedMs => {
    const root = await attachmentRoot()
    await Promise.all(taskIds.map(taskId => writeAttachment(root, taskId)))
    vi.useFakeTimers()
    vi.setSystemTime(0)
    let reachedWrite
    const writingStarted = new Promise(resolve => {
      reachedWrite = resolve
    })
    vi.spyOn(filesystem, 'writeFile').mockImplementation(() => {
      reachedWrite()
      return new Promise(resolve => setTimeout(resolve, elapsedMs))
    })
    const result = observe(
      fileVerification(root).verifyTaskAttachments(taskIds.map(taskId => ({ taskId })))
    )
    await writingStarted

    await vi.advanceTimersByTimeAsync(elapsedMs)
    const outcome = await result
    expect(outcome.error).toBeInstanceOf(Error)
    expect(outcome.error.message).toMatch(/attachment verification.*within 10000ms/)
  })

  test('shares one deadline between directory traversal and evidence writing', async () => {
    const root = await attachmentRoot()
    await Promise.all(taskIds.map(taskId => writeAttachment(root, taskId)))
    const entries = await filesystem.readdir(join(root, taskIds[0], 'attachments'), {
      withFileTypes: true,
    })
    vi.useFakeTimers()
    vi.setSystemTime(0)
    vi.spyOn(filesystem, 'readdir').mockImplementationOnce(
      () => new Promise(resolve => setTimeout(() => resolve(entries), 6_000))
    )
    let reachedWrite
    const writingStarted = new Promise(resolve => {
      reachedWrite = resolve
    })
    vi.spyOn(filesystem, 'writeFile').mockImplementation(() => {
      reachedWrite()
      return new Promise(resolve => setTimeout(resolve, 5_000))
    })
    const result = observe(
      fileVerification(root).verifyTaskAttachments(taskIds.map(taskId => ({ taskId })))
    )
    await vi.advanceTimersByTimeAsync(6_000)
    await writingStarted
    await vi.advanceTimersByTimeAsync(5_000)

    const outcome = await result
    expect(outcome.error).toBeInstanceOf(Error)
    expect(outcome.error.message).toMatch(/attachment verification.*within 10000ms/)
  })
})

test('does not accept an owning runtime response after the shared step deadline', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  const address = {
    deviceId: 'wework-e2e-cloud-device',
    taskId: taskIds[0],
    workspacePath: '/cloud/project',
  }
  const verification = createCloudAttachmentVerification({
    control: { command: async () => JSON.stringify({ pane: { currentRuntimeTask: address } }) },
    cloudEnvironment: {
      runtimeWork: () =>
        new Promise(resolve =>
          setTimeout(
            () =>
              resolve({
                projects: [
                  {
                    deviceWorkspaces: [{ ...address, tasks: [address] }],
                  },
                ],
                chats: [],
              }),
            10_001
          )
        ),
    },
    workspacePath: address.workspacePath,
  })

  const result = verification.verifySubmittedTask().then(
    value => ({ value }),
    error => ({ error })
  )
  await vi.advanceTimersByTimeAsync(10_001)
  const outcome = await result
  expect(outcome.error).toBeInstanceOf(Error)
  expect(outcome.error.message).toMatch(/within 10000ms/)
})

test.each(['snapshot', 'runtime'])(
  'bounds an unresponsive %s read by the shared step deadline',
  async stalledRead => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const address = {
      deviceId: 'wework-e2e-cloud-device',
      taskId: taskIds[0],
      workspacePath: '/cloud/project',
    }
    const neverResponds = () => new Promise(() => {})
    const verification = createCloudAttachmentVerification({
      control: {
        command:
          stalledRead === 'snapshot'
            ? neverResponds
            : async () => JSON.stringify({ pane: { currentRuntimeTask: address } }),
      },
      cloudEnvironment: { runtimeWork: neverResponds },
      workspacePath: address.workspacePath,
    })
    let settled = false
    const result = verification.verifySubmittedTask().then(
      value => {
        settled = true
        return { value }
      },
      error => {
        settled = true
        return { error }
      }
    )

    await vi.advanceTimersByTimeAsync(9_999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const outcome = await result
    expect(outcome.error.message).toMatch(/within 10000ms/)
    expect(vi.getTimerCount()).toBe(0)
  }
)

describe('cloud attachment task ownership', () => {
  test.each([null, '/wrong/workspace'])(
    'refreshes an unresolved UI workspace while rejecting a resolved mismatch: %s',
    async initialWorkspace => {
      vi.useFakeTimers()
      vi.setSystemTime(0)
      const address = {
        deviceId: CLOUD_DEVICE_ID,
        taskId: taskIds[0],
        workspacePath: '/cloud/project',
      }
      const snapshot = workspacePath =>
        JSON.stringify({ pane: { currentRuntimeTask: { ...address, workspacePath } } })
      const command = vi.fn().mockResolvedValue(snapshot(address.workspacePath))
      command.mockResolvedValueOnce(snapshot(initialWorkspace))
      const verification = createCloudAttachmentVerification({
        control: { command },
        cloudEnvironment: {
          runtimeWork: async () => ({
            projects: [{ deviceWorkspaces: [{ ...address, tasks: [address] }] }],
            chats: [],
          }),
        },
        workspacePath: address.workspacePath,
      })
      const result = observe(verification.verifySubmittedTask())
      await vi.advanceTimersByTimeAsync(100)
      const outcome = await result
      if (initialWorkspace === null) {
        expect(outcome.error).toBeUndefined()
        expect(outcome.value).toEqual(address)
        expect(command).toHaveBeenCalledTimes(2)
      } else {
        expect(outcome.error?.message).toMatch(/workspace differs from its owning cloud runtime/)
        expect(command).toHaveBeenCalledTimes(1)
      }
    }
  )

  test('uses the owning cloud project source key even when a local project shares its path', () => {
    const projectWork = {
      project: { key: 'cloud-device:/cloud/project', name: 'Workspace' },
      deviceWorkspaces: [{ deviceId, workspacePath: '/cloud/project', available: true, id: null }],
    }
    const runtimeWork = {
      projects: [
        {
          project: { key: 'local-device:/cloud/project', id: 42, name: 'Workspace' },
          deviceWorkspaces: [{ deviceId: 'local-device', workspacePath: '/cloud/project' }],
        },
        projectWork,
      ],
    }

    expect(findOwnedRuntimeProject(runtimeWork, deviceId, '/cloud/project/')).toEqual({
      projectWork,
      workspace: projectWork.deviceWorkspaces[0],
    })
  })

  test('rejects a project directory that only exists on the local device', () => {
    const runtimeWork = {
      projects: [
        {
          project: { key: 'local-device:/cloud/project' },
          deviceWorkspaces: [{ deviceId: 'local-device', workspacePath: '/cloud/project' }],
        },
      ],
    }

    expect(() => findOwnedRuntimeProject(runtimeWork, deviceId, '/cloud/project')).toThrow(
      /owning cloud project/
    )
  })

  test('reads the selected cloud task despite a local task with the same ID', () => {
    const cloudTask = { taskId: taskIds[0], workspacePath: '/cloud/project' }
    const cloudWorkspace = { deviceId, workspacePath: '/cloud/project', tasks: [cloudTask] }
    const runtimeWork = {
      projects: [{ project: { key: 'cloud-source' }, deviceWorkspaces: [cloudWorkspace] }],
      chats: [
        {
          deviceId: 'local-device',
          workspacePath: '/local/chat',
          tasks: [{ taskId: taskIds[0], workspacePath: '/local/chat' }],
        },
      ],
    }

    expect(findOwnedRuntimeTask(runtimeWork, deviceId, taskIds[0])).toEqual({
      task: cloudTask,
      workspace: cloudWorkspace,
    })
  })

  test('fails immediately when the selected task only belongs to the local device', () => {
    const runtimeWork = {
      projects: [],
      chats: [{ deviceId: 'local-device', tasks: [{ taskId: taskIds[0] }] }],
    }

    expect(() => findOwnedRuntimeTask(runtimeWork, deviceId, taskIds[0])).toThrow(
      /wrong device.*local-device/
    )
  })

  test('prepares the cloud composer with a synthetic renderer workspace ID and null backend ID', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const workspacePath = '/cloud/project'
    const selection = {
      currentProject: {
        id: 823954920,
        config: {
          execution: { deviceId: CLOUD_DEVICE_ID },
          workspace: { localPath: workspacePath },
        },
      },
      selectedDeviceWorkspaceId: 823954920,
      currentRuntimeTask: null,
    }
    const verification = createCloudAttachmentVerification({
      cloudEnvironment: {
        runtimeWork: async () => ({
          projects: [
            {
              project: { key: `${CLOUD_DEVICE_ID}:${workspacePath}` },
              deviceWorkspaces: [
                { id: null, deviceId: CLOUD_DEVICE_ID, workspacePath, available: true },
              ],
            },
          ],
        }),
      },
      control: {
        command: async command => {
          if (command === 'getWorkbenchDebugSnapshot')
            return JSON.stringify({ workbench: selection })
          if (command === 'getText') return DEFAULT_MODEL_LABEL
          if (command === 'getAttribute') return MODEL_PROVIDER_ID
          return ''
        },
      },
      composerSelector: '[data-testid="composer"]',
      projectRowSelector: '[data-testid="project-menu-823954920"]',
      projectUiId: '823954920',
      workspacePath,
    })

    const result = observe(verification.prepareConversation())
    await vi.advanceTimersByTimeAsync(10_000)
    const outcome = await result
    expect(outcome.error).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  test.each([
    ['another workspace', '/cloud/another-project', null, /workspace changed/],
    ['an existing task', '/cloud/project', { taskId: taskIds[0] }, /retained an existing task/],
  ])(
    'rejects a composer for %s despite a matching cloud project and device',
    (_name, path, task, message) => {
      const selection = {
        currentProject: {
          id: 716972942,
          config: {
            execution: { deviceId },
            workspace: { localPath: path },
          },
        },
        currentRuntimeTask: task,
      }

      expect(() =>
        assertCloudAttachmentProjectSelection(selection, {
          projectUiId: '716972942',
          deviceId,
          workspacePath: '/cloud/project',
        })
      ).toThrow(message)
    }
  )

  test('accepts the observed UI project ID rather than a backend project ID', () => {
    const selection = {
      currentProject: {
        id: 716972942,
        config: {
          execution: { deviceId },
          workspace: { localPath: '/cloud/project/' },
        },
      },
      selectedDeviceWorkspaceId: null,
      currentRuntimeTask: null,
    }

    expect(() =>
      assertCloudAttachmentProjectSelection(selection, {
        projectUiId: '716972942',
        deviceId,
        workspacePath: '/cloud/project',
      })
    ).not.toThrow()
    expect(() =>
      assertCloudAttachmentProjectSelection(selection, {
        projectUiId: '42',
        deviceId,
        workspacePath: '/cloud/project',
      })
    ).toThrow(/project UI identity/)
  })

  test('rejects a local composer even when its displayed project ID matches', () => {
    const selection = {
      currentProject: {
        id: 716972942,
        config: {
          execution: { deviceId: 'local-device' },
          workspace: { localPath: '/cloud/project' },
        },
      },
      currentRuntimeTask: null,
    }

    expect(() =>
      assertCloudAttachmentProjectSelection(selection, {
        projectUiId: '716972942',
        deviceId,
        workspacePath: '/cloud/project',
      })
    ).toThrow(/execution device/)
  })
})

describe('private task attachment files', () => {
  test('checks both task directories under the configured root and their actual image bytes', async () => {
    const root = await attachmentRoot()
    const paths = await Promise.all(taskIds.map(taskId => writeAttachment(root, taskId)))

    await expect(
      assertRuntimeTaskAttachments({ root, taskIds, filename, expectedBytes: image })
    ).resolves.toEqual(paths)
  })

  test('a historical same-name attachment cannot replace the missing second task file', async () => {
    const root = await attachmentRoot()
    await writeAttachment(root, taskIds[0])
    await writeAttachment(root, 'runtime-historical')

    await expect(
      assertRuntimeTaskAttachments({ root, taskIds, filename, expectedBytes: image })
    ).rejects.toThrow(/runtime-second.*missing attachment/)
  })

  test('rejects different image bytes at the expected filename', async () => {
    const root = await attachmentRoot()
    await writeAttachment(root, taskIds[0])
    await writeAttachment(root, taskIds[1], Buffer.from('different image'))

    await expect(
      assertRuntimeTaskAttachments({ root, taskIds, filename, expectedBytes: image })
    ).rejects.toThrow(/runtime-second.*image bytes/)
  })

  test('does not let the same task directory satisfy two independent conversations', async () => {
    const root = await attachmentRoot()
    await writeAttachment(root, taskIds[0])

    await expect(
      assertRuntimeTaskAttachments({
        root,
        taskIds: [taskIds[0], taskIds[0]],
        filename,
        expectedBytes: image,
      })
    ).rejects.toThrow(/different task IDs/)
  })
})
