// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TemplateBindings } from './TemplateBindings'
import { builtinCollaborationTemplates } from './builtins'
import { validateTemplate } from './document'
import { templateAgentReferences } from './agents'
import { TemplateCreateSection } from './TemplateCreateSection'
import { CollaborationTemplateContext } from './context'
import { CollaborationTemplateStore } from './store'

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function () {
    this.open = false
  }
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

it.each([true, false])(
  'removes an imported role together with its stages (embedded: %s)',
  async embedded => {
    const template = structuredClone(builtinCollaborationTemplates()[0].document)
    const group = template.spec.resources.collaboration.groups[0]
    const removedRole = group.roles[1]
    group.stages.push({ ...group.stages[0], key: 'unassigned', ownerRole: null })
    if (!embedded) delete removedRole.agentKey
    const onChange = vi.fn()
    await act(async () =>
      root.render(
        <TemplateBindings document={template} locale="zh-CN" candidates={[]} onChange={onChange} />
      )
    )
    const button = container.querySelector<HTMLButtonElement>(
      `[data-testid="template-remove-role-${group.key}-${removedRole.key}"]`
    )!
    expect(button.getAttribute('aria-label')).toContain(removedRole.name)
    await act(async () => button.click())

    const [drafts, configured] = onChange.mock.lastCall!
    expect(drafts).not.toBeNull()
    expect(validateTemplate(configured)).toEqual(configured)
    expect(configured.spec.resources.collaboration.groups[0].roles).toHaveLength(
      group.roles.length - 1
    )
    expect(
      container.querySelector(`[data-testid="template-role-${group.key}-${removedRole.key}"]`)
    ).toBeNull()
    const references = templateAgentReferences(drafts)
    expect(references.has(`template-agent:${group.roles[1].key}`)).toBe(false)
    const retainedStages = group.stages.filter(stage => stage.ownerRole !== removedRole.key)
    expect(configured.spec.resources.collaboration.groups[0].stages).toEqual(retainedStages)
    expect(drafts[0].stages.map((stage: { id: string }) => stage.id)).toEqual(
      retainedStages.map(stage => stage.key)
    )
    expect(template.spec.resources.collaboration.groups[0].roles).toHaveLength(6)
  }
)

it('keeps the coordinator and blocks removal while disabled', async () => {
  const template = builtinCollaborationTemplates()[0].document
  const group = template.spec.resources.collaboration.groups[0]
  const onChange = vi.fn()
  const render = (disabled: boolean) =>
    act(async () =>
      root.render(
        <TemplateBindings
          document={template}
          locale="en"
          candidates={[]}
          disabled={disabled}
          onChange={onChange}
        />
      )
    )
  await render(true)
  for (const button of container.querySelectorAll<HTMLButtonElement>(
    '[data-testid^="template-remove-role-"]'
  )) {
    expect(button.disabled).toBe(true)
    await act(async () => button.click())
  }
  expect(onChange.mock.lastCall![1].spec.resources.collaboration.groups[0].roles).toHaveLength(6)
  await render(false)
  expect(
    container.querySelector<HTMLButtonElement>(
      `[data-testid="template-remove-role-${group.key}-${group.leaderRole}"]`
    )!.disabled
  ).toBe(true)
  for (const role of group.roles.filter(role => role.key !== group.leaderRole)) {
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          `[data-testid="template-remove-role-${group.key}-${role.key}"]`
        )!
        .click()
    )
  }
  const [drafts, configured] = onChange.mock.lastCall!
  expect(
    configured.spec.resources.collaboration.groups[0].roles.map((role: { key: string }) => role.key)
  ).toEqual([group.leaderRole])
  expect(drafts[0].members).toHaveLength(1)
  expect(templateAgentReferences(drafts).size).toBe(1)
  expect(drafts[0].stages).toHaveLength(group.stages.filter(stage => !stage.ownerRole).length)
})

it('passes the reduced template and drafts to project creation without changing the source', async () => {
  const template = builtinCollaborationTemplates()[0].document
  const store = new CollaborationTemplateStore({
    scope: 'local:test',
    ownerId: 7,
    persistence: { read: async () => [], write: async () => {} },
  })
  const onChange = vi.fn()
  await act(async () =>
    root.render(
      <CollaborationTemplateContext value={store}>
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
          initialTemplate={template}
          onSelect={vi.fn()}
          onChange={onChange}
        />
      </CollaborationTemplateContext>
    )
  )
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[data-testid="template-remove-role-main-role-1"]')!
      .click()
  )
  const [drafts, selected, configured] = onChange.mock.lastCall!
  expect(selected).toBe(true)
  expect(drafts[0].members).toHaveLength(5)
  expect(configured.spec.resources.collaboration.groups[0].roles).toHaveLength(5)
  expect(
    configured.spec.resources.collaboration.groups[0].stages.every(
      (stage: { ownerRole: string | null }) => stage.ownerRole !== 'main-role-1'
    )
  ).toBe(true)
  expect(template.spec.resources.collaboration.groups[0].roles).toHaveLength(6)
})

it('resets removed roles when selecting a template with the same name and version', async () => {
  const template = structuredClone(builtinCollaborationTemplates()[0].document)
  template.metadata.namespace = 'another-namespace'
  const store = new CollaborationTemplateStore({
    scope: 'local:test',
    ownerId: 7,
    persistence: { read: async () => [], write: async () => {} },
  })
  const onChange = vi.fn()
  await act(async () =>
    root.render(
      <CollaborationTemplateContext value={store}>
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
          initialTemplate={template}
          onSelect={vi.fn()}
          onChange={onChange}
        />
      </CollaborationTemplateContext>
    )
  )
  for (const testId of [
    'template-remove-role-main-role-1',
    'project-create-choose-template',
    'template-details-product-lifecycle',
    'template-use',
  ]) {
    await act(async () =>
      container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!.click()
    )
  }
  const [drafts, , configured] = onChange.mock.lastCall!
  expect(configured.metadata.namespace).toBe('system')
  expect(drafts[0].members).toHaveLength(6)
  expect(configured.spec.resources.collaboration.groups[0].roles).toHaveLength(6)
  expect(container.querySelector('[data-testid="template-remove-role-main-role-1"]')).not.toBeNull()
})
