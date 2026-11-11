import { afterEach, describe, expect, test, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { createTodoHtml } from './workbench-todo.js'

const windows: JSDOM[] = []
afterEach(() => {
  for (const dom of windows.splice(0)) dom.window.close()
})

function createApp(get = vi.fn(async (): Promise<unknown> => null)) {
  const sdk = {
    storage: {
      get,
      set: vi.fn<(value: unknown) => Promise<void>>(async () => {}),
      commit: vi.fn<(input: { value: unknown; reminders: unknown[] }) => Promise<void>>(
        async () => {}
      ),
    },
    reminders: {
      list: vi.fn(async (): Promise<Array<{ id: string; at: string }>> => []),
      schedule: vi.fn<(value: unknown) => Promise<void>>(async () => {}),
      cancel: vi.fn<(id: string) => Promise<void>>(async () => {}),
    },
    window: { hide: vi.fn(async () => {}), setAlwaysOnTop: vi.fn(async () => {}) },
  }
  const dom = new JSDOM(createTodoHtml('en'), {
    url: 'https://workbench-test.invalid/',
    runScripts: 'dangerously',
    beforeParse(window) {
      Object.defineProperty(window, 'weworkWorkbench', { value: sdk })
    },
  })
  windows.push(dom)
  const document = dom.window.document
  const input = document.getElementById('text') as HTMLInputElement
  const submit = () =>
    document
      .getElementById('add-form')!
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
  return { dom, document, sdk, input, submit }
}

describe('bundled TODO note', () => {
  test('protects stored tasks while their initial read is pending', async () => {
    let resolve: ((value: unknown) => void) | undefined
    const get = vi.fn(
      () =>
        new Promise(value => {
          resolve = value
        })
    )
    const { document, input, submit, sdk } = createApp(get)
    expect(input.disabled).toBe(true)
    input.value = 'new task'
    submit()
    expect(sdk.storage.commit).not.toHaveBeenCalled()
    resolve?.([{ id: 'saved', text: 'Existing task', done: false, at: null }])
    await vi.waitFor(() => expect(input.disabled).toBe(false))
    expect(document.querySelector('#items label')?.textContent).toBe('Existing task')
  })

  test('preserves data and exposes retry after a failed initial read', async () => {
    const get = vi
      .fn(async (): Promise<unknown> => null)
      .mockRejectedValueOnce(new Error('Disk unavailable'))
    const { document, input, sdk } = createApp(get)
    await vi.waitFor(() => expect(document.getElementById('retry')?.hidden).toBe(false))
    expect(input.disabled).toBe(true)
    expect(document.getElementById('status')?.textContent).toBe('Disk unavailable')
    expect(sdk.storage.set).not.toHaveBeenCalled()
    get.mockResolvedValueOnce([{ id: 'saved', text: 'Recovered task', done: false, at: null }])
    ;(document.getElementById('retry') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(input.disabled).toBe(false))
    expect(document.querySelector('#items label')?.textContent).toBe('Recovered task')
  })

  test('saves task data and reminders through one atomic operation', async () => {
    const { document, input, submit, sdk } = createApp()
    await vi.waitFor(() => expect(input.disabled).toBe(false))
    input.value = 'Send report'
    const time = document.getElementById('remind-at') as HTMLInputElement
    const future = new Date(Date.now() + 60_000)
    time.value = `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, '0')}-${String(future.getDate()).padStart(2, '0')}T${String(future.getHours()).padStart(2, '0')}:${String(future.getMinutes()).padStart(2, '0')}:${String(future.getSeconds()).padStart(2, '0')}`
    submit()
    await vi.waitFor(() => expect(document.querySelectorAll('#items li')).toHaveLength(1))
    expect(sdk.storage.commit).toHaveBeenCalledOnce()
    const saved = sdk.storage.commit.mock.calls[0][0]
    expect(saved.value).toEqual([expect.objectContaining({ text: 'Send report', done: false })])
    expect(saved.reminders).toEqual([
      expect.objectContaining({
        id: (saved.value as Array<{ id: string }>)[0].id,
        body: 'Send report',
      }),
    ])
    expect(sdk.storage.set).not.toHaveBeenCalled()
    expect(sdk.reminders.schedule).not.toHaveBeenCalled()
    expect(sdk.reminders.cancel).not.toHaveBeenCalled()
  })

  test('a failed atomic save leaves the task and reminder unchanged', async () => {
    const task = {
      id: 'saved',
      text: 'Keep reminder',
      done: false,
      at: new Date(Date.now() + 60_000).toISOString(),
    }
    const { document, input, sdk } = createApp(vi.fn(async () => [task]))
    await vi.waitFor(() => expect(input.disabled).toBe(false))
    sdk.storage.commit.mockRejectedValueOnce(new Error('Commit failed'))
    ;(document.querySelector('#items input') as HTMLInputElement).click()
    await vi.waitFor(() =>
      expect(document.getElementById('status')?.textContent).toBe('Commit failed')
    )
    expect(sdk.storage.commit).toHaveBeenCalledOnce()
    expect(sdk.storage.set).not.toHaveBeenCalled()
    expect(sdk.reminders.cancel).not.toHaveBeenCalled()
    expect((document.querySelector('#items input') as HTMLInputElement).checked).toBe(false)
  })

  test('uses the selected language and second precision reminder inputs', () => {
    expect(createTodoHtml('zh-CN')).toContain('TODO 便签')
    expect(createTodoHtml('en-US')).toContain('TODO note')
    expect(createTodoHtml('en-US')).toContain('step="1"')
  })
})
