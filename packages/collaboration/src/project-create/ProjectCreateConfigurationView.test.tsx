// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { ProjectCreateConfigurationView } from './ProjectCreateConfigurationView'

it('initially focuses a native editable instruction field without an explicit tab index', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () =>
      root.render(
        <section role="dialog" aria-modal="true">
          <ProjectCreateConfigurationView onBack={() => {}} backLabel="Back to project">
            <div contentEditable suppressContentEditableWarning data-testid="instructions">
              Instructions
            </div>
          </ProjectCreateConfigurationView>
        </section>
      )
    )
    const editor = container.querySelector<HTMLElement>('[data-testid="instructions"]')!
    expect(editor.hasAttribute('tabindex')).toBe(false)
    expect(editor.tabIndex).toBe(-1)
    expect(document.activeElement).toBe(editor)
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})

it('respects an explicit negative tab index on an editable field', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () =>
      root.render(
        <section role="dialog" aria-modal="true">
          <ProjectCreateConfigurationView onBack={() => {}} backLabel="Back to project">
            <div contentEditable suppressContentEditableWarning tabIndex={-1}>
              Excluded field
            </div>
            <input aria-label="Instructions" />
          </ProjectCreateConfigurationView>
        </section>
      )
    )
    expect(document.activeElement).toBe(container.querySelector('input'))
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})

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

it.each(['result', 'failure', 'result-back', 'failure-back', 'result-outside', 'failure-outside'])(
  'recovers owned focus across an async configuration transition (%s)',
  async outcome => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const renderStage = async (stage: 'input' | 'working' | 'result') => {
      await act(async () =>
        root.render(
          <ProjectCreateConfigurationView
            onBack={() => {}}
            backLabel="Back to project"
            testId="configuration"
            focusLabel="Organize a collaboration group"
            focusTarget={stage === 'working' ? null : `[data-testid="${stage}"]`}
          >
            {stage === 'input' ? (
              <input data-testid="input" aria-label="Division requirements" />
            ) : stage === 'result' ? (
              <button data-testid="result">Review group</button>
            ) : (
              <p role="status">Generating</p>
            )}
          </ProjectCreateConfigurationView>
        )
      )
    }
    const outside = document.createElement('button')
    outside.textContent = 'Other dialog action'
    document.body.append(outside)
    try {
      await renderStage('input')
      const input = container.querySelector<HTMLElement>('[data-testid="input"]')!
      expect(document.activeElement).toBe(input)
      await renderStage('working')
      const configuration = container.querySelector<HTMLElement>('[data-testid="configuration"]')!
      expect(input.isConnected).toBe(false)
      expect(document.activeElement).toBe(configuration)
      expect(configuration.getAttribute('aria-label')).toBe('Organize a collaboration group')
      const back = container.querySelector<HTMLElement>(
        '[data-testid="collaboration-project-create-configuration-back"]'
      )!
      if (outcome.endsWith('-back')) await act(async () => back.focus())
      if (outcome.endsWith('-outside')) await act(async () => outside.focus())
      const destination = outcome.startsWith('result') ? 'result' : 'input'
      await renderStage(destination)
      expect(document.activeElement).toBe(
        outcome.endsWith('-back')
          ? back
          : outcome.endsWith('-outside')
            ? outside
            : container.querySelector(`[data-testid="${destination}"]`)
      )
    } finally {
      await act(async () => root.unmount())
      container.remove()
      outside.remove()
    }
  }
)
