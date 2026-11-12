import { afterEach, describe, expect, test, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTodoHtml } from './workbench-todo.js'
import { createTodoProject } from './workbench-todo-project.js'

const windows: JSDOM[] = []
const roots: string[] = []
afterEach(async () => {
  for (const dom of windows.splice(0)) dom.window.close()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function createApp(get = vi.fn(async (): Promise<unknown> => null)) {
  const sdk = {
    storage: {
      get,
      set: vi.fn<(value: unknown) => Promise<void>>(async () => {}),
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
    expect(sdk.storage.set).toHaveBeenCalledExactlyOnceWith([
      { id: expect.any(String), text: 'Write report', done: false },
    ])
    expect(input.value).toBe('')
    expect(document.activeElement).toBe(input)
  })

  test('Enter saves ordinary state and clears the editor after success', async () => {
    const { document, input, enter, sdk } = createApp()
    await vi.waitFor(() => expect(input.disabled).toBe(false))
    input.value = 'Keyboard task'
    expect(enter().defaultPrevented).toBe(true)
    await vi.waitFor(() =>
      expect(document.querySelector('#items label')?.textContent).toBe('Keyboard task')
    )
    expect(sdk.storage.set).toHaveBeenCalledExactlyOnceWith([
      { id: expect.any(String), text: 'Keyboard task', done: false },
    ])
    expect(input.value).toBe('')
  })

  test.each(['', ' \t '])('ignores empty text %j for both entry methods', async value => {
    const { document, input, add, enter, sdk } = createApp()
    await vi.waitFor(() => expect(input.disabled).toBe(false))
    input.value = value
    add.click()
    enter()
    expect(sdk.storage.set).not.toHaveBeenCalled()
    expect(document.querySelectorAll('#items li')).toHaveLength(0)
  })

  test.each([{ isComposing: true }, { keyCode: 229 }])(
    'preserves IME confirmation %j until a later Enter submits the committed text',
    async init => {
      const { document, input, enter, sdk } = createApp()
      await vi.waitFor(() => expect(input.disabled).toBe(false))
      input.value = '待办事项'
      expect(enter(init).defaultPrevented).toBe(false)
      expect(sdk.storage.set).not.toHaveBeenCalled()
      expect(input.value).toBe('待办事项')
      expect(document.querySelectorAll('#items li')).toHaveLength(0)
      enter()
      await vi.waitFor(() =>
        expect(document.querySelector('#items label')?.textContent).toBe('待办事项')
      )
      expect(sdk.storage.set).toHaveBeenCalledOnce()
    }
  )

  test.each(['click', 'Enter'])('preserves the draft after %s fails to save', async method => {
    const saved = { id: 'saved', text: 'Existing task', done: false }
    const { document, input, add, enter, sdk } = createApp(vi.fn(async () => [saved]))
    await vi.waitFor(() => expect(input.disabled).toBe(false))
    sdk.storage.set.mockRejectedValueOnce(new Error('Save failed'))
    input.value = 'New draft'
    const trigger = () => (method === 'click' ? add.click() : enter())
    trigger()
    await vi.waitFor(() =>
      expect(document.getElementById('status')?.textContent).toBe('Save failed')
    )
    expect(document.querySelectorAll('#items li')).toHaveLength(1)
    expect(document.querySelector('#items label')?.textContent).toBe(saved.text)
    expect(input.value).toBe('New draft')
    expect(input.disabled).toBe(false)
    trigger()
    await vi.waitFor(() => expect(document.querySelectorAll('#items li')).toHaveLength(2))
    expect(sdk.storage.set).toHaveBeenLastCalledWith([
      saved,
      { id: expect.any(String), text: 'New draft', done: false },
    ])
    expect(sdk.storage.set).toHaveBeenCalledTimes(2)
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
    expect(sdk.storage.set).not.toHaveBeenCalled()
    resolve?.([{ id: 'saved', text: 'Existing task', done: false }])
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
    get.mockResolvedValueOnce([{ id: 'saved', text: 'Recovered task', done: false }])
    ;(document.getElementById('retry') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(input.disabled).toBe(false))
    expect(document.querySelector('#items label')?.textContent).toBe('Recovered task')
  })

  test.each(['complete', 'delete'])('a failed %s leaves the saved task unchanged', async action => {
    const task = { id: 'saved', text: 'Keep task', done: false }
    const { document, input, sdk } = createApp(vi.fn(async () => [task]))
    await vi.waitFor(() => expect(input.disabled).toBe(false))
    sdk.storage.set.mockRejectedValueOnce(new Error('Save failed'))
    const target = action === 'complete' ? '#items input' : '#items button'
    ;(document.querySelector(target) as HTMLElement).click()
    await vi.waitFor(() =>
      expect(document.getElementById('status')?.textContent).toBe('Save failed')
    )
    expect(sdk.storage.set).toHaveBeenCalledOnce()
    expect(document.querySelectorAll('#items li')).toHaveLength(1)
    expect(document.querySelector('#items label')?.textContent).toBe(task.text)
    expect((document.querySelector('#items input') as HTMLInputElement).checked).toBe(false)
    expect(input.disabled).toBe(false)
  })

  test.each([null, 'obsolete timestamp', { obsolete: true }])(
    'keeps ordinary saved tasks usable when obsolete timing metadata is %j',
    async at => {
      const saved = { id: 'saved', text: 'Existing task', done: false, at }
      const { document, input, sdk } = createApp(vi.fn(async () => [saved]))
      await vi.waitFor(() => expect(input.disabled).toBe(false))
      expect(document.querySelector('#items label')?.textContent).toBe(saved.text)
      expect(document.querySelector('time')).toBeNull()
      ;(document.querySelector('#items input') as HTMLInputElement).click()
      await vi.waitFor(() =>
        expect(sdk.storage.set).toHaveBeenCalledExactlyOnceWith([{ ...saved, done: true }])
      )
      await vi.waitFor(() => expect(input.disabled).toBe(false))
      ;(document.querySelector('#items button') as HTMLButtonElement).click()
      await vi.waitFor(() => expect(document.querySelectorAll('#items li')).toHaveLength(0))
      expect(sdk.storage.set).toHaveBeenLastCalledWith([])
    }
  )

  test('blocks duplicate submission and publishes a task only after its save completes', async () => {
    const { document, input, add, enter, sdk } = createApp()
    await vi.waitFor(() => expect(input.disabled).toBe(false))
    let release!: () => void
    sdk.storage.set.mockImplementationOnce(() => new Promise<void>(resolve => (release = resolve)))
    input.value = 'Pending task'
    add.click()
    enter()
    expect(sdk.storage.set).toHaveBeenCalledOnce()
    expect(input.disabled).toBe(true)
    expect(input.value).toBe('Pending task')
    expect(document.querySelectorAll('#items li')).toHaveLength(0)
    release()
    await vi.waitFor(() => expect(document.querySelectorAll('#items li')).toHaveLength(1))
    expect(input.disabled).toBe(false)
    expect(input.value).toBe('')
  })

  test('keeps hide and pin controls independent of task persistence', async () => {
    const { document, input, sdk } = createApp()
    await vi.waitFor(() => expect(input.disabled).toBe(false))
    const pin = document.getElementById('pin') as HTMLButtonElement
    pin.click()
    await vi.waitFor(() => expect(pin.getAttribute('aria-pressed')).toBe('true'))
    expect(sdk.window.setAlwaysOnTop).toHaveBeenLastCalledWith(true)
    pin.click()
    await vi.waitFor(() => expect(pin.getAttribute('aria-pressed')).toBe('false'))
    expect(sdk.window.setAlwaysOnTop).toHaveBeenLastCalledWith(false)
    ;(document.getElementById('hide') as HTMLButtonElement).click()
    expect(sdk.window.hide).toHaveBeenCalledOnce()
    expect(sdk.storage.set).not.toHaveBeenCalled()
  })

  test('uses the selected language without offering a reminder time', () => {
    expect(createTodoHtml('zh-CN')).toContain('TODO 便签')
    expect(createTodoHtml('en-US')).toContain('TODO note')
    const { document } = createApp()
    expect(document.querySelector('input[type="datetime-local"]')).toBeNull()
  })

  test.each(['zh-CN', 'en-US'])(
    'creates a local TODO without notification consent for %s',
    async locale => {
      const root = await mkdtemp(join(tmpdir(), 'wework-todo-project-'))
      roots.push(root)
      const project = await createTodoProject(root, locale)
      const manifest = JSON.parse(await readFile(join(project, 'plugin-manifest.json'), 'utf8'))
      expect(manifest.flavor).toBe('lightweight')
      expect(manifest.capabilities?.native ?? []).toEqual([])
      const html = await readFile(join(project, 'view.html'), 'utf8')
      expect(html).toContain('data-testid="todo-add"')
      expect(html).not.toContain('datetime-local')
    }
  )
})
