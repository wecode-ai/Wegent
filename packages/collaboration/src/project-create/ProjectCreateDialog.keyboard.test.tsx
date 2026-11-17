// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ProjectCreationAction } from '../platform/ProjectCreationAction'
import { ProjectCreateDialog } from './ProjectCreateDialog'
import { projectCreateLabels } from './labels'

let container: HTMLDivElement
let root: Root

function Harness({ generation = false }: { generation?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <ProjectCreationAction
        testId="create-project"
        className=""
        supportsLocalImport
        messages={{
          addProject: '新建项目',
          blankProject: '新建空白项目',
          addFolder: '添加文件夹',
          importExistingProject: '导入项目',
        }}
        onSelect={() => setOpen(true)}
      />
      <button data-testid="background-action">Background</button>
      {open && (
        <ProjectCreateDialog
          targets={[{ location: 'local', create: vi.fn() }]}
          defaultLocation="local"
          allowDingTalkAITable={false}
          labels={projectCreateLabels['zh-CN']}
          onClose={() => setOpen(false)}
          onCreated={vi.fn()}
          resourceSetup={{
            location: 'local',
            currentUser: { id: 1, name: 'Me' },
            members: [],
            agents: generation ? [{ id: 'agent', name: 'Reviewer' } as never] : [],
            defaultAgentResourceIds: generation ? ['agent'] : [],
            ...(generation ? { generateCollaborationGroupDraft: vi.fn() } : {}),
            groups: [],
            configure: vi.fn(),
          }}
        />
      )}
    </>
  )
}

const get = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!
const click = async (id: string) => act(async () => get(id).click())
async function key(target: HTMLElement, value: string, shiftKey = false) {
  const event = new KeyboardEvent('keydown', {
    key: value,
    shiftKey,
    bubbles: true,
    cancelable: true,
  })
  await act(async () => target.dispatchEvent(event))
  return event
}

beforeEach(async () => {
  vi.useFakeTimers()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  // jsdom omits text-range layout APIs used by the focused ProseMirror editor.
  Object.defineProperties(Range.prototype, {
    getClientRects: { configurable: true, value: () => [] },
    getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(<Harness />))
  await click('create-project')
  await click('create-project-blank')
})
afterEach(async () => {
  await act(async () => root.unmount())
  if (vi.isFakeTimers()) await act(async () => vi.runOnlyPendingTimersAsync())
  vi.useRealTimers()
  container.remove()
  vi.unstubAllGlobals()
})

it('closes the group-model dialog with Escape while preserving the project draft', async () => {
  await act(async () => root.render(<Harness key="generation" generation />))
  await click('create-project')
  await click('create-project-blank')
  const name = get('cloud-project-name') as HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(name, 'Keep this project')
    name.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await click('collaboration-project-create-add-collaborator')
  await click('collaboration-project-create-collaborator-tab-agents')
  await click('collaboration-project-create-agent-agent')
  await click('collaboration-project-create-add-collaborator')
  await click('collaboration-project-create-collaborator-tab-groups')
  await click('collaboration-project-create-new-group')
  const dialog = get('collaboration-project-create-model-picker')
  expect(dialog).not.toBeNull()
  await act(async () => vi.runOnlyPendingTimersAsync())
  expect(
    dialog.contains(document.activeElement),
    `Group dialog focus escaped to ${document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName}`
  ).toBe(true)
  await key(dialog.querySelector('button')!, 'Escape')
  await act(async () => vi.runOnlyPendingTimersAsync())
  expect(get('collaboration-project-create-model-picker')).toBeNull()
  expect(get('collaboration-project-create-dialog')).not.toBeNull()
  expect((get('cloud-project-name') as HTMLInputElement).value).toBe('Keep this project')
  expect(document.activeElement).toBe(get('collaboration-project-create-add-collaborator'))
})

it('names the project dialog, contains Tab, and restores its stable menu opener after Escape', async () => {
  const dialog = get('collaboration-project-create-dialog')
  expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe(
    projectCreateLabels['zh-CN'].title
  )
  expect(document.activeElement).toBe(get('cloud-project-name'))
  const first = get('collaboration-project-create-close')
  const last = dialog.querySelector<HTMLButtonElement>(
    '.collaboration-project-create-footer-actions button:not(:disabled)'
  )!
  last.focus()
  expect((await key(last, 'Tab')).defaultPrevented).toBe(true)
  expect(document.activeElement).toBe(first)
  expect((await key(first, 'Tab', true)).defaultPrevented).toBe(true)
  expect(document.activeElement).toBe(last)
  await key(last, 'Escape')
  expect(get('collaboration-project-create-dialog')).toBeNull()
  expect(document.activeElement).toBe(get('create-project'))
})

it('dismisses a nested collaborator picker before its project dialog and restores focus on close', async () => {
  await click('collaboration-project-create-add-collaborator')
  await key(get('collaboration-project-create-people-search'), 'Escape')
  expect(get('collaboration-project-create-collaborator-menu')).toBeNull()
  expect(get('collaboration-project-create-dialog')).not.toBeNull()
  await click('collaboration-project-create-close')
  expect(get('collaboration-project-create-dialog')).toBeNull()
  expect(document.activeElement).toBe(get('create-project'))
})
