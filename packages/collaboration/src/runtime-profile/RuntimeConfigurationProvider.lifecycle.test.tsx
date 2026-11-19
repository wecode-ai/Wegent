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

it('owns the modal dialog until removal and clears requests across project changes', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
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
    const getDialog = () => document.querySelector('[data-testid="runtime-configuration-dialog"]')
    const dialog = getDialog()
    expect(dialog?.getAttribute('role')).toBe('dialog')
    expect(dialog?.getAttribute('aria-modal')).toBe('true')
    expect(dialog?.contains(document.activeElement)).toBe(true)
    await act(async () => root.render(view('one')))
    expect(getDialog()).toBe(dialog)
    await act(async () => root.render(view('two')))
    expect(getDialog()).toBeNull()
    expect(dialog?.isConnected).toBe(false)
    await act(async () => root.render(view('one')))
    expect(getDialog()).toBeNull()
  } finally {
    await act(async () => root.unmount())
    node.remove()
    vi.restoreAllMocks()
  }
})
