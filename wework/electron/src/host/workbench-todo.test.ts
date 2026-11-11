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
  const add = document.getElementById('add') as HTMLButtonElement
  const enter = (init: KeyboardEventInit = {}) => {
    const event = new dom.window.KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
      ...init,
    })
    input.dispatchEvent(event)
    return event
  }
  return { dom, document, sdk, input, add, enter }
}

describe('bundled TODO note', () => {
  test('adds and saves through the button without a native form submission', async () => {
    const { document, input, add, sdk } = createApp()
    await vi.waitFor(() => expect(input.disabled).toBe(false))
    expect(input.form).toBeNull()
    expect(add.type).toBe('button')
    input.value = '  Write report  '
    add.click()
    await vi.waitFor(() =>
      expect(document.querySelector('#items label')?.textContent).toBe('Write report')
    )
    expect(sdk.storage.commit).toHaveBeenCalledExactlyOnceWith({
      value: [{ id: expect.any(String), text: 'Write report', done: false, at: null }],
      reminders: [],
    })
    expect(input.value).toBe('')
    expect(document.activeElement).toBe(input)
  })

  test('Enter uses the same atomic save and clears the editor after success', async () => {
    const { document, input, enter, sdk } = createApp()
    await vi.waitFor(() => expect(input.disabled).toBe(false))
    input.value = 'Keyboard task'
    expect(enter().defaultPrevented).toBe(true)
    await vi.waitFor(() =>
      expect(document.querySelector('#items label')?.textContent).toBe('Keyboard task')
    )
    expect(sdk.storage.commit).toHaveBeenCalledExactlyOnceWith({
      value: [{ id: expect.any(String), text: 'Keyboard task', done: false, at: null }],
      reminders: [],
    })
    expect(input.value).toBe('')
  })

  test.each(['', ' \t '])('ignores empty text %j for both entry methods', async value => {
    const { document, input, add, enter, sdk } = createApp()
    await vi.waitFor(() => expect(input.disabled).toBe(false))
    input.value = value
    add.click()
    enter()
    expect(sdk.storage.commit).not.toHaveBeenCalled()
    expect(document.querySelectorAll('#items li')).toHaveLength(0)
  })

  test.each([{ isComposing: true }, { keyCode: 229 }])(
    'preserves IME confirmation %j until a later Enter submits the committed text',
    async init => {
      const { document, input, enter, sdk } = createApp()
      await vi.waitFor(() => expect(input.disabled).toBe(false))
      input.value = '待办事项'
      expect(enter(init).defaultPrevented).toBe(false)
      expect(sdk.storage.commit).not.toHaveBeenCalled()
      expect(input.value).toBe('待办事项')
      expect(document.querySelectorAll('#items li')).toHaveLength(0)
      enter()
      await vi.waitFor(() =>
        expect(document.querySelector('#items label')?.textContent).toBe('待办事项')
      )
      expect(sdk.storage.commit).toHaveBeenCalledOnce()
    }
  )

  test.each(['click', 'Enter'])('preserves the draft after %s fails to save', async method => {
    const saved = { id: 'saved', text: 'Existing task', done: false, at: null }
    const { document, input, add, enter, sdk } = createApp(vi.fn(async () => [saved]))
    await vi.waitFor(() => expect(input.disabled).toBe(false))
    sdk.storage.commit.mockRejectedValueOnce(new Error('Commit failed'))
    input.value = 'New draft'
    const trigger = () => (method === 'click' ? add.click() : enter())
    trigger()
    await vi.waitFor(() =>
      expect(document.getElementById('status')?.textContent).toBe('Commit failed')
    )
    expect(document.querySelectorAll('#items li')).toHaveLength(1)
    expect(document.querySelector('#items label')?.textContent).toBe(saved.text)
    expect(input.value).toBe('New draft')
    expect(input.disabled).toBe(false)
    trigger()
    await vi.waitFor(() => expect(document.querySelectorAll('#items li')).toHaveLength(2))
    expect(sdk.storage.commit).toHaveBeenLastCalledWith({
      value: [saved, { id: expect.any(String), text: 'New draft', done: false, at: null }],
      reminders: [],
    })
    expect(sdk.storage.commit).toHaveBeenCalledTimes(2)
    expect(input.value).toBe('')
  })

  test('protects stored tasks while their initial read is pending', async () => {
    let resolve: ((value: unknown) => void) | undefined
    const get = vi.fn(
      () =>
        new Promise(value => {
          resolve = value
        })
    )
    const { document, input, add, enter, sdk } = createApp(get)
    expect(input.disabled).toBe(true)
    input.value = 'new task'
    add.click()
    enter()
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
    const { document, input, add, sdk } = createApp()
    await vi.waitFor(() => expect(input.disabled).toBe(false))
    input.value = 'Send report'
    const time = document.getElementById('remind-at') as HTMLInputElement
    const future = new Date(Date.now() + 60_000)
    time.value = `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, '0')}-${String(future.getDate()).padStart(2, '0')}T${String(future.getHours()).padStart(2, '0')}:${String(future.getMinutes()).padStart(2, '0')}:${String(future.getSeconds()).padStart(2, '0')}`
    add.click()
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
