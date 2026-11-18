// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCollaborationTranslator } from '../i18n'
import type { CollaborationProject } from '../types'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import { strategyRevision } from '../issue-detail/strategyTestFixtures'
import { ProjectStrategySettings } from './ProjectStrategySettings'
import { strategyTextDiff } from './strategyTextDiff'

let root: Root | undefined
let container: HTMLDivElement
const project = {
  id: 'project-1',
  version: 3,
  access_role: 'Maintainer',
  agentic_strategy_enabled: true,
  collaboration_strategy: strategyRevision,
  collaboration_strategy_versions: [strategyRevision],
} as CollaborationProject
async function render(overrides: Partial<ComponentProps<typeof ProjectStrategySettings>> = {}) {
  if (!root) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  }
  const update = vi.fn(async () => ({ ...project, version: 4 }))
  await act(async () =>
    root!.render(
      <ProjectStrategySettings
        api={{ projects: { update } } as unknown as SharedWorkspaceApi}
        project={project}
        members={[]}
        locale="en"
        translate={createCollaborationTranslator('en')}
        onChange={vi.fn()}
        {...overrides}
      />
    )
  )
  return update
}
async function fill(value: string) {
  await act(async () => {
    const input = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="project-strategy-text"]'
    )!
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  container?.remove()
})

describe('readable project strategy publication', () => {
  it('publishes only text and the expected immutable version', async () => {
    const update = await render()
    await fill('Updated readable strategy')
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="project-strategy-save"]')!.click()
    )
    expect(update).toHaveBeenCalledWith('project-1', {
      version: 3,
      collaborationStrategy: { text: 'Updated readable strategy', expected_version: 1 },
    })
    expect(container.textContent).toContain('Running Issues keep their original strategy snapshot')
    expect(container.textContent).toContain('product-owner')
    expect(container.querySelector('select')).toBeNull()
    expect(container.textContent).not.toContain('depends_on')
    expect(container.textContent).not.toContain('docs/35')
  })

  it('retains a local draft through project polling and renders its textual changes', async () => {
    await render()
    await fill('Local draft')
    await render({
      project: { ...project, version: 4, collaboration_strategy: { ...strategyRevision } },
    })
    expect(container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Local draft')
    expect(container.querySelector('[data-change="added"]')?.textContent).toContain('Local draft')
    expect(
      container.querySelector('[data-testid="project-strategy-version-1"]')?.textContent
    ).toContain('v1')
  })

  it('offers an explicit first publication from the project description and respects rollback', async () => {
    const unpublished = {
      ...project,
      description: 'Readable project policy',
      collaboration_strategy: null,
      collaboration_strategy_versions: [],
    }
    const update = await render({ project: unpublished })
    expect(update).not.toHaveBeenCalled()
    expect(container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe(
      'Readable project policy'
    )
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="project-strategy-save"]')!.click()
    )
    expect(update).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({
        collaborationStrategy: { text: 'Readable project policy', expected_version: 0 },
      })
    )
    await render({ project: { ...unpublished, agentic_strategy_enabled: false } })
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="project-strategy-save"]')!.disabled
    ).toBe(true)
    expect(container.querySelector<HTMLTextAreaElement>('textarea')!.disabled).toBe(true)
  })

  it('resets the draft when switching projects with the same strategy version', async () => {
    await render()
    await fill('Unsaved project one draft')
    await render({
      project: {
        ...project,
        id: 'project-2',
        collaboration_strategy: { ...strategyRevision, text: 'Project two strategy' },
      },
    })
    expect(container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe(
      'Project two strategy'
    )
  })

  it('reports an exact readable replacement diff without mutating either version', () => {
    expect(strategyTextDiff('Same\nOld\nEnd', 'Same\nNew\nEnd')).toEqual([
      { kind: 'unchanged', text: 'Same' },
      { kind: 'removed', text: 'Old' },
      { kind: 'added', text: 'New' },
      { kind: 'unchanged', text: 'End' },
    ])
  })
})
