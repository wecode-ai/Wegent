import { sdkSelectValue } from '../test/selectControl'
// @vitest-environment jsdom
import { act, useState, useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TemplateCreateSection } from './TemplateCreateSection'
import { createTemplatePageNavigation, templateConfigurationDetail } from './templatePageNavigation'
import { CollaborationTemplateContext } from './context'
import { CollaborationTemplateStore } from './store'
import { builtinCollaborationTemplates } from './builtins'
import type { CollaborationTemplate } from './types'

let root: Root
let container: HTMLDivElement
let target: HTMLDivElement

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  target = document.createElement('div')
  document.body.append(container, target)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  target.remove()
})

const button = (testId: string) =>
  document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!
const click = async (testId: string) => {
  await act(async () => {
    button(testId).focus()
    button(testId).click()
  })
}

function Harness({
  initial = false,
  onSelect = vi.fn(),
}: {
  initial?: boolean
  onSelect?(document: CollaborationTemplate | null): void
}) {
  const [store] = useState(
    () =>
      new CollaborationTemplateStore({
        scope: 'local:configuration',
        ownerId: 7,
        persistence: { read: async () => [], write: async () => {} },
      })
  )
  const [templateNavigation] = useState(() => createTemplatePageNavigation(store))
  const templateState = useSyncExternalStore(
    templateNavigation.subscribe,
    templateNavigation.getSnapshot,
    templateNavigation.getSnapshot
  )
  const navigation = templateConfigurationDetail(templateNavigation, 'en', templateState)
  return (
    <CollaborationTemplateContext value={store}>
      <h2 data-testid="host-title">{navigation?.title ?? 'Create project'}</h2>
      <div hidden={Boolean(navigation)}>
        <TemplateCreateSection
          setup={{
            location: 'local',
            currentUser: { id: 7, name: 'Owner' },
            members: [],
            agents: [],
            groups: [],
            configure: async () => {},
          }}
          locale="en"
          initialTemplate={initial ? builtinCollaborationTemplates()[0].document : undefined}
          configurationHost={{
            target,
            navigation: templateNavigation,
          }}
          onSelect={onSelect}
          onChange={vi.fn()}
        />
      </div>
    </CollaborationTemplateContext>
  )
}

it('keeps binding edits when returning to the project and reopening configuration', async () => {
  await act(async () => root.render(<Harness initial />))
  expect(button('project-create-configure-template')).toBeTruthy()
  const view = document.querySelector<HTMLElement>(
    '[data-testid="project-create-template-configuration"]'
  )!
  expect(view.hidden).toBe(true)
  await click('project-create-configure-template')
  expect(view.hidden).toBe(false)
  expect(view.contains(document.activeElement)).toBe(true)
  const name = target.querySelector<HTMLInputElement>('[data-testid="template-group-name-main"]')!
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(name, 'Edited group')
    name.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await click('collaboration-project-create-configuration-back')
  expect(view.hidden).toBe(true)
  expect(document.activeElement).toBe(button('project-create-configure-template'))
  await click('project-create-configure-template')
  expect(view.contains(document.activeElement)).toBe(true)
  expect(target.querySelector('[data-testid="template-group-name-main"]')).toBe(name)
  expect(name.value).toBe('Edited group')
})

it('shows template details inline and returns to the catalog without another dialog', async () => {
  await act(async () => root.render(<Harness />))
  await click('project-create-choose-template')
  await click('template-details-product-lifecycle')
  expect(document.querySelectorAll('dialog')).toHaveLength(0)
  expect(target.querySelector('[data-testid="template-inline-detail"]')).not.toBeNull()
  const catalog = target.querySelector('[data-testid="project-create-template-catalog"]')!
  const footer = catalog.querySelector(':scope > footer')!
  expect(footer.contains(button('template-use'))).toBe(true)
  expect(
    catalog
      .querySelector('.collaboration-project-create-configuration-body')!
      .contains(button('template-use'))
  ).toBe(false)
  expect(document.querySelector('[data-testid="template-detail-cancel"]')).toBeNull()

  expect(
    target.querySelector('[data-testid="template-inline-detail"]')!.contains(document.activeElement)
  ).toBe(true)
  await click('collaboration-project-create-configuration-back')
  expect(target.querySelector('[data-testid="template-inline-detail"]')).toBeNull()
  expect(button('template-search')).toBeTruthy()
  await click('template-details-product-lifecycle')
  await click('template-use')
  expect(
    target.querySelector<HTMLElement>('[data-testid="project-create-template-configuration"]')!
      .hidden
  ).toBe(false)
  expect(document.querySelectorAll('dialog')).toHaveLength(0)
})

it('keeps an incomplete configuration editable after returning to the project', async () => {
  await act(async () => root.render(<Harness initial />))
  await click('project-create-configure-template')
  const disclosure = target.querySelector<HTMLElement>('[data-testid^="template-customize-"]')!
  expect(disclosure.getAttribute('aria-expanded')).toBe('false')
  await act(async () => {
    disclosure.click()
  })
  const select = target.querySelector<HTMLElement>('[data-testid="template-role-main-role-0"]')!
  const original = await sdkSelectValue(select)
  await sdkSelectValue(select, '')
  expect(button('project-create-template-configuration-apply').disabled).toBe(true)
  await click('collaboration-project-create-configuration-back')
  expect(container.textContent).toContain('Some roles need members.')
  await click('project-create-configure-template')
  expect(await sdkSelectValue(select)).toBe('')
  await sdkSelectValue(select, original)
  expect(button('project-create-template-configuration-apply').disabled).toBe(false)
  await click('project-create-template-configuration-apply')
  expect(document.activeElement).toBe(button('project-create-configure-template'))
  expect(
    target.querySelector<HTMLElement>('[data-testid="project-create-template-configuration"]')!
      .hidden
  ).toBe(true)
})

it('keeps import actions in the same fixed footer and uses its single return control', async () => {
  await act(async () => root.render(<Harness />))
  await click('project-create-choose-template')
  await click('template-import-open')
  const catalog = target.querySelector('[data-testid="project-create-template-catalog"]')!
  const footer = catalog.querySelector(':scope > footer')!
  const content = catalog.querySelector('.collaboration-project-create-configuration-body')!
  expect(footer.contains(button('template-import-save'))).toBe(true)
  expect(content.contains(button('template-import-save'))).toBe(false)
  expect(document.querySelector('[data-testid="template-import-cancel"]')).toBeNull()
  await click('collaboration-project-create-configuration-back')
  expect(target.querySelector('[data-testid="template-import-file"]')).toBeNull()
  expect(document.activeElement).toBe(button('template-import-open'))
})

it.each(builtinCollaborationTemplates())(
  'passes English project and role defaults from $document.metadata.name into creation',
  async record => {
    const onSelect = vi.fn()
    await act(async () => root.render(<Harness onSelect={onSelect} />))
    await click('project-create-choose-template')
    await click(`template-details-${record.document.metadata.name}`)
    await click('template-use')
    const selected = onSelect.mock.calls[0][0] as CollaborationTemplate
    const resources = selected.spec.resources.collaboration
    expect(JSON.stringify(resources)).not.toMatch(/[\u3400-\u9fff]/)
    expect(resources.project.name).not.toBe(
      record.document.spec.resources.collaboration.project.name
    )
    expect(
      target.querySelector<HTMLInputElement>('[data-testid="template-group-name-main"]')!.value
    ).toBe(resources.groups[0].name)
    expect(target.textContent).toContain(resources.groups[0].roles[0].name)
  }
)
