import { describe, expect, it, vi } from 'vitest'
import { WorkbenchLaunchQueue, openNativeScheme } from './workbench-launch-queue.js'
import { parseWorkbenchUrl } from './workbench-application-contract.js'

describe('native application launch routing', () => {
  it('creates the workbench for regular links received in an app-only session', async () => {
    const workbenches = new WorkbenchLaunchQueue(vi.fn())
    const queuedWorkbenchLinks: string[] = []
    const openWorkbench = vi.fn(async () => undefined)
    const queueScheme = (url: string) => {
      if (workbenches.enqueue(url)) return true
      queuedWorkbenchLinks.push(url)
      return false
    }
    await openNativeScheme('wework://workbenches/todo', queueScheme, openWorkbench)
    expect(openWorkbench).not.toHaveBeenCalled()
    await openNativeScheme('wework://tasks/device/task', queueScheme, openWorkbench)
    expect(queuedWorkbenchLinks).toEqual(['wework://tasks/device/task'])
    expect(openWorkbench).toHaveBeenCalledOnce()
  })
  it('buffers cold launches without a workbench and deduplicates pending requests', async () => {
    const queue = new WorkbenchLaunchQueue(vi.fn())
    const open = vi.fn(async () => undefined)
    expect(queue.enqueue('wework://workbenches/todo')).toBe(true)
    queue.enqueue('wework://workbenches/todo')
    expect(queue.hasPending()).toBe(true)
    expect(open).not.toHaveBeenCalled()
    await queue.start(open)
    expect(open).toHaveBeenCalledExactlyOnceWith('todo')
    expect(queue.hasPending()).toBe(false)
  })

  it('continues dispatching live native links after an app fails', async () => {
    const report = vi.fn()
    const queue = new WorkbenchLaunchQueue(report)
    const open = vi.fn(async (id: string) => {
      if (id === 'missing') throw new Error('missing')
    })
    await queue.start(open)
    queue.enqueue('wework://workbenches/missing')
    queue.enqueue('wework://workbenches/notes')
    await queue.start(open)
    expect(report).toHaveBeenCalledOnce()
    expect(open.mock.calls.map(([id]) => id)).toEqual(['missing', 'notes'])
  })

  it('opens other apps while one document is still loading', async () => {
    let releaseLoading!: () => void
    const loading = new Promise<void>(resolve => {
      releaseLoading = resolve
    })
    let notesOpened!: () => void
    const opened = new Promise<void>(resolve => {
      notesOpened = resolve
    })
    const open = vi.fn(async (id: string) => {
      if (id === 'loading') await loading
      else notesOpened()
    })
    const queue = new WorkbenchLaunchQueue(vi.fn())
    queue.enqueue('wework://workbenches/loading')
    queue.enqueue('wework://workbenches/notes')
    const startup = queue.start(open)

    await opened
    expect(open.mock.calls.map(([id]) => id)).toEqual(['loading', 'notes'])
    queue.enqueue('wework://workbenches/loading')
    expect(open).toHaveBeenCalledTimes(2)
    releaseLoading()
    await startup
  })

  it.each([
    'wework://boards/1',
    'https://workbenches/todo',
    'wework://workbenches/../private',
    'wework://workbenches/a/b',
    'wework://workbenches/%2e%2e',
    'wework://user@workbenches/todo',
    'wework://workbenches/todo?command=other',
    'wework://workbenches/todo#script',
  ])('does not consume unrelated or malformed links: %s', url => {
    expect(parseWorkbenchUrl(url)).toBeNull()
    expect(new WorkbenchLaunchQueue(vi.fn()).enqueue(url)).toBe(false)
  })
})
