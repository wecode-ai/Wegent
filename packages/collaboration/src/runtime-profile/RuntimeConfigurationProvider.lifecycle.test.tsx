// @vitest-environment jsdom
import { act, useContext } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { RuntimeConfigurationProvider } from './RuntimeConfigurationProvider'
import { RuntimeConfigurationContext } from './context'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'

vi.mock('../project-manage/ProjectRuntimeSettings', () => ({
  ProjectRuntimeSettings: () => <div>Settings</div>,
}))

it('owns the native dialog until removal and clears requests across project changes', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const previousShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal')
  const previousClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close')
  const show = vi.fn(function (this: HTMLDialogElement) {
    this.open = true
  })
  const close = vi.fn(function (this: HTMLDialogElement) {
    this.open = false
  })
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value: show },
    close: { configurable: true, value: close },
  })
  const node = document.createElement('div')
  document.body.append(node)
  const root = createRoot(node)
  const api = {
    automationExecutionCatalog: {},
  } as unknown as SharedWorkspaceApi
  function Open() {
    const open = useContext(RuntimeConfigurationContext)
    return <button onClick={() => open?.()}>Open</button>
  }
  const view = (id: string) => (
    <RuntimeConfigurationProvider
      api={api}
      project={{ id } as NonNullable<Parameters<typeof RuntimeConfigurationProvider>[0]['project']>}
      locale="en"
    >
      <Open />
    </RuntimeConfigurationProvider>
  )
  try {
    await act(async () => root.render(view('one')))
    await act(async () => node.querySelector<HTMLButtonElement>('button')!.click())
    const dialog = node.querySelector('dialog')!
    expect(dialog.open).toBe(true)
    expect(show).toHaveBeenCalledTimes(1)
    await act(async () => root.render(view('one')))
    expect(show).toHaveBeenCalledTimes(1)
    await act(async () => root.render(view('two')))
    expect(node.querySelector('dialog')).toBeNull()
    expect(dialog.open).toBe(false)
    expect(close).toHaveBeenCalledTimes(1)
    await act(async () => root.render(view('one')))
    expect(node.querySelector('dialog')).toBeNull()
  } finally {
    await act(async () => root.unmount())
    node.remove()
    if (previousShow) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', previousShow)
    else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal')
    if (previousClose) Object.defineProperty(HTMLDialogElement.prototype, 'close', previousClose)
    else Reflect.deleteProperty(HTMLDialogElement.prototype, 'close')
    vi.restoreAllMocks()
  }
})
