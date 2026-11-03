import { describe, expect, test, vi } from 'vitest'
import {
  isolatedWorkbenchEnvironment,
  WorkbenchRuntimeManager,
  type WorkbenchRuntimeHandle,
} from './workbench-runtime.js'

function fakeRuntime(url: string, pid: number): WorkbenchRuntimeHandle {
  return {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    url: () => url,
    pid: () => pid,
  }
}

describe('WorkbenchRuntimeManager', () => {
  test('starts one isolated DSH process per dynamic tab', async () => {
    const handles = [
      fakeRuntime('http://127.0.0.1:4101', 101),
      fakeRuntime('http://127.0.0.1:4102', 102),
    ]
    const options = []
    const manager = new WorkbenchRuntimeManager(runtimeOptions => {
      options.push(runtimeOptions)
      return handles[options.length - 1]
    })

    await manager.open({
      tabId: 'smart-app:one',
      url: 'http://127.0.0.1:4101',
      command: '/runtime/dsh',
    })
    await manager.open({
      tabId: 'smart-app:two',
      url: 'http://127.0.0.1:4102',
      command: '/runtime/dsh',
    })

    expect(manager.list()).toEqual([
      { tabId: 'smart-app:one', url: 'http://127.0.0.1:4101', pid: 101 },
      { tabId: 'smart-app:two', url: 'http://127.0.0.1:4102', pid: 102 },
    ])
    expect(options).toHaveLength(2)
    expect(options[0].hostPipe).toBeUndefined()
  })

  test('reuses one process for repeated opens of the same tab and stops it on close', async () => {
    const handle = fakeRuntime('http://127.0.0.1:4201', 201)
    const factory = vi.fn(() => handle)
    const manager = new WorkbenchRuntimeManager(factory)
    const launch = {
      tabId: 'smart-app:review',
      url: 'http://127.0.0.1:4201',
      command: '/runtime/dsh',
    }

    await manager.open(launch)
    await manager.open(launch)
    await manager.close(launch.tabId)

    expect(factory).toHaveBeenCalledOnce()
    expect(handle.start).toHaveBeenCalledOnce()
    expect(handle.stop).toHaveBeenCalledOnce()
    expect(manager.get(launch.tabId)).toBeNull()
  })

  test('does not inherit core Host or executor credentials', () => {
    expect(
      isolatedWorkbenchEnvironment({
        PATH: '/usr/bin',
        DSH_HOME: '/workbench',
        WEWORK_ELECTRON_HOST_TOKEN: 'secret',
        WEWORK_EXECUTOR_TOKEN: 'secret',
        WEGENT_APP_IPC_TOKEN: 'secret',
      })
    ).toEqual({
      PATH: '/usr/bin',
      DSH_HOME: '/workbench',
    })
  })

  test('passes a fresh scoped Host pipe only when the workbench launch provides one', async () => {
    const handle = fakeRuntime('http://127.0.0.1:4301', 301)
    const options = []
    const hostPipe = { environment: () => ({ WEWORK_ELECTRON_HOST_TOKEN: 'fresh-token' }) }
    const manager = new WorkbenchRuntimeManager(runtimeOptions => {
      options.push(runtimeOptions)
      return handle
    })

    await manager.open({
      tabId: 'smart-app:owner-capture',
      url: 'http://127.0.0.1:4301',
      command: '/runtime/dsh',
      environment: {
        WEWORK_ELECTRON_HOST_TOKEN: 'core-token',
        WEWORK_DSH_BROWSER_AUTH: '1',
      },
      hostPipe: hostPipe as never,
      hostPrincipal: '@wegent/dsh-workbench',
    })

    expect(options[0]).toMatchObject({
      hostPipe,
      env: {
        WEWORK_ELECTRON_HOST_TOKEN: 'fresh-token',
        WEWORK_ELECTRON_HOST_PRINCIPAL: '@wegent/dsh-workbench',
      },
    })
  })

  test.each([undefined, 'legacy'])(
    'rejects an explicit privileged pipe in %s authentication mode',
    async authentication => {
      const factory = vi.fn()
      const manager = new WorkbenchRuntimeManager(factory)
      await expect(
        manager.open({
          tabId: 'legacy',
          url: 'http://127.0.0.1:4301',
          command: '/runtime/dsh',
          environment: { WEWORK_DSH_BROWSER_AUTH: authentication },
          hostPipe: { environment: () => ({}) } as never,
          hostPrincipal: '@wegent/dsh-workbench',
        })
      ).rejects.toThrow('Workbench Host pipe requires native browser authentication')
      expect(factory).not.toHaveBeenCalled()
      expect(manager.list()).toEqual([])
    }
  )
})
