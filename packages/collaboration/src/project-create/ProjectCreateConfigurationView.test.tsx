// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { ProjectCreateConfigurationView } from './ProjectCreateConfigurationView'

it.each(['Escape', 'header'])(
  'returns to a visible destination after %s when the menu entry is gone',
  async action => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    function Harness() {
      const [open, setOpen] = useState(true)
      return (
        <section role="dialog" aria-modal="true">
          <button data-testid="header" onClick={() => setOpen(false)}>
            Close configuration
          </button>
          <div hidden={open}>
            <button data-testid="collaborator-trigger">Add collaborators</button>
          </div>
          {open && (
            <ProjectCreateConfigurationView
              onBack={() => setOpen(false)}
              backLabel="Back to project"
              restoreFocus='[data-testid="collaborator-trigger"]'
            >
              <input aria-label="Instructions" />
            </ProjectCreateConfigurationView>
          )}
        </section>
      )
    }
    try {
      await act(async () => root.render(<Harness />))
      expect(document.activeElement?.tagName).toBe('INPUT')
      await act(async () => {
        if (action === 'Escape')
          document.activeElement!.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
          )
        else {
          const header = container.querySelector<HTMLButtonElement>('[data-testid="header"]')!
          header.focus()
          header.click()
        }
      })
      expect(document.activeElement).toBe(
        container.querySelector('[data-testid="collaborator-trigger"]')
      )
      expect(document.activeElement?.closest('[hidden]')).toBeNull()
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  }
)
