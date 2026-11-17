// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CollaborationTemplateContext } from '../templates/context'
import { CollaborationTemplateStore } from '../templates/store'
import { builtinCollaborationTemplates } from '../templates/builtins'
import { ProjectCreateDialog } from './ProjectCreateDialog'
import { projectCreateLabels } from './labels'

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})
const get = <T extends HTMLElement>(id: string) =>
  document.querySelector<T>(`[data-testid="${id}"]`)!
const click = async (id: string) => {
  await act(async () => get(id).click())
}

it.each(['用户说明：仅审核桌面端。\n保留权限范围 🔒', ''])(
  'fills only an empty description when a template is selected (description=%j)',
  async description => {
    const store = new CollaborationTemplateStore({
      scope: 'cloud:template-draft',
      ownerId: 7,
      persistence: { read: async () => [], write: async () => {} },
    })
    await act(async () =>
      root.render(
        <CollaborationTemplateContext value={store}>
          <ProjectCreateDialog
            targets={[{ location: 'cloud', create: vi.fn() }]}
            defaultLocation="cloud"
            labels={projectCreateLabels['zh-CN']}
            allowDingTalkAITable={false}
            onClose={vi.fn()}
            onCreated={vi.fn()}
            resourceSetup={{
              location: 'cloud',
              currentUser: { id: 7, name: 'Owner' },
              members: [],
              agents: [],
              groups: [],
              configure: vi.fn(),
            }}
          />
        </CollaborationTemplateContext>
      )
    )
    await click('collaboration-project-create-advanced')
    const field = get<HTMLTextAreaElement>('cloud-project-description')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        field,
        description
      )
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click('project-create-choose-template')
    await click('template-details-research-analysis')
    await click('template-use')
    const defaults = builtinCollaborationTemplates().find(
      record => record.document.metadata.name === 'research-analysis'
    )!.document.spec.resources.collaboration.project
    expect(field.value).toBe(description || defaults.description)
    await click('collaboration-project-create-configuration-back')
    await click('project-create-clear-template')
    expect(get<HTMLTextAreaElement>('cloud-project-description')).toBe(field)
    expect(field.value).toBe(description || defaults.description)
  }
)
