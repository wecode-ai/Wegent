// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { AgentPromptEditor } from './AgentPromptEditor'
import type { AgentCapabilitySkill } from './AgentCapabilitiesSelector'
import type { UnifiedAgentPluginRef } from './types'
import { createCollaborationTranslator } from '../i18n'

const translate = createCollaborationTranslator('zh-CN')
const emptyPlugins: UnifiedAgentPluginRef[] = []
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value: () => [],
  })
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => new DOMRect(),
  })
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  )
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})
function Harness({
  skills,
  plugins = emptyPlugins,
}: {
  skills: AgentCapabilitySkill[]
  plugins?: UnifiedAgentPluginRef[]
}) {
  const [value, onChange] = useState('')
  return (
    <AgentPromptEditor
      busy={false}
      field={{ value, onChange, label: 'Prompt', testId: 'agent-prompt' }}
      skills={skills}
      plugins={plugins}
      translate={translate}
    />
  )
}
const element = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
async function type(value: string) {
  const editor = element('agent-prompt') as HTMLElement & { value: string }
  await act(async () => {
    editor.value = value
    editor.focus()
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: value.at(-1), bubbles: true }))
  })
  return editor
}

test('updates an open skill catalog without broadcasting events or remounting the prompt', async () => {
  const oldSkills = [{ id: 1, name: 'review' }],
    nextSkills = [{ id: 2, name: 'respond' }]
  await act(async () => root.render(<Harness skills={oldSkills} />))
  const editor = await type('$re')
  expect(element('local-skill-option-review')).not.toBeNull()
  await act(async () => root.render(<Harness skills={nextSkills} />))
  expect(element('local-skill-option-respond')).not.toBeNull()
  expect(element('local-skill-option-review')).toBeNull()
  expect(element('agent-prompt')).toBe(editor)
  expect(editor.value).toBe('$re')
})

test('uses new skills when a previously closed menu is opened and keeps the prompt draft', async () => {
  const oldSkills = [{ id: 1, name: 'review' }],
    nextSkills = [{ id: 2, name: 'respond' }]
  await act(async () => root.render(<Harness skills={oldSkills} />))
  const editor = element('agent-prompt')
  await act(async () => root.render(<Harness skills={nextSkills} />))
  await type('$re')
  expect(element('local-skill-option-respond')).not.toBeNull()
  expect(element('local-skill-option-review')).toBeNull()
  expect(element('agent-prompt')).toBe(editor)
})
