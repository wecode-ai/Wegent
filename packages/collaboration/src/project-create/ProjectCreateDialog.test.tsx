// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ProjectCreationAction } from '../platform/ProjectCreationAction'
import { ProjectCreateDialog } from './ProjectCreateDialog'
import { projectCreateLabels } from './labels'

let container: HTMLDivElement
let root: Root

function Harness() {
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
            agents: [],
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
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(<Harness />))
  await click('create-project')
  await click('create-project-blank')
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

it('names the project dialog, contains Tab, and restores its stable menu opener after Escape', async () => {
  const dialog = get('collaboration-project-create-dialog')
  expect(dialog.getAttribute('aria-label')).toBe(projectCreateLabels['zh-CN'].title)
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
