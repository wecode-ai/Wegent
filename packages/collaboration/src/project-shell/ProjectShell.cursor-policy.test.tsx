// @vitest-environment jsdom

import { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test } from 'vitest'
import { ProjectShell } from './ProjectShell'

test('owns the cursor only for the visible board view, including retained tabs', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const render = (boardView: boolean) =>
    act(() =>
      root.render(
        <StrictMode>
          <ProjectShell
            assistantOpen={false}
            boardView={boardView}
            embedded
            hasCreateAction={false}
            sidebarCollapsed={false}
            title="Project"
            titleIcon={null}
            renderRightActions={() => null}
            renderViewSwitcher={() => null}
          >
            Content
          </ProjectShell>
        </StrictMode>
      )
    )
  try {
    container.hidden = true
    render(true)
    expect(document.body.dataset.boardCursorPolicy).toBeUndefined()
    container.hidden = false
    await act(async () => {
      await Promise.resolve()
    })
    expect(document.body.dataset.boardCursorPolicy).toBe('arrow')
    render(false)
    expect(document.body.dataset.boardCursorPolicy).toBeUndefined()
    render(true)
    expect(document.body.dataset.boardCursorPolicy).toBe('arrow')
    container.hidden = true
    await act(async () => {
      await Promise.resolve()
    })
    expect(document.body.dataset.boardCursorPolicy).toBeUndefined()
  } finally {
    act(() => root.unmount())
    container.remove()
  }
  expect(document.body.dataset.boardCursorPolicy).toBeUndefined()
})
