// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkflowNodeInstance } from '../automation/types'
import { createCollaborationTranslator } from '../i18n'
import { createTestWorkflowNode } from './strategyTestFixtures'
import { WorkflowDeliverablesForm } from './WorkflowDeliverablesForm'

let root: Root | undefined
let container: HTMLDivElement
async function render(id: string, onSubmit = vi.fn(async () => undefined)) {
  const requirements: Record<string, WorkflowNodeInstance['required_deliverables']> = {
    product_intake: [
      {
        id: 'acceptance_criteria',
        name: 'Acceptance criteria',
        description: 'Acceptance criteria',
        value_type: 'text',
      },
    ],
    qa_test: [
      {
        id: 'test_evidence',
        name: 'Test evidence',
        description: 'Test evidence',
        value_type: 'file',
        file_constraints: { accepted_types: [], min_files: 1, max_files: 1 },
      },
      { id: 'qa_decision', name: 'QA decision', description: 'QA decision', value_type: 'text' },
    ],
    dev_implementation: [
      {
        id: 'code_snapshot_or_pull_request',
        name: 'Code snapshot or PR',
        description: 'Code evidence',
        value_type: 'code_snapshot',
        accepted_value_types: ['pull_request'],
      },
    ],
    merge_release: [
      {
        id: 'merged_pull_request',
        name: 'Merged PR',
        description: 'Merged PR',
        value_type: 'pull_request',
        pull_request_state: 'merged',
      },
    ],
  }
  const node = createTestWorkflowNode(id, { required_deliverables: requirements[id] })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () =>
    root!.render(
      <WorkflowDeliverablesForm
        node={node}
        translate={createCollaborationTranslator('en')}
        onSubmit={onSubmit}
      />
    )
  )
  return onSubmit
}
async function fill(id: string, value: string) {
  await act(async () => {
    const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      `[data-testid="${id}"]`
    )!
    const prototype =
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function submit() {
  await act(async () =>
    container
      .querySelector<HTMLFormElement>('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  )
}
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  container?.remove()
})

describe('stage evidence authoring', () => {
  it('rejects an empty submission and preserves limits on selected files', async () => {
    const onSubmit = await render('qa_test')
    await submit()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Enter or select at least one evidence item'
    )
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>(
        '[data-testid="workflow-deliverable-test_evidence-file"]'
      )!
      Object.defineProperty(input, 'files', {
        value: [new File(['one'], 'one.txt'), new File(['two'], 'two.txt')],
        configurable: true,
      })
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await submit()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('requires 1–1 files')
  })

  it('keeps product text after a rejected submission so it can be corrected and retried', async () => {
    const onSubmit = vi
      .fn()
      .mockRejectedValueOnce(new Error('Stage changed; refresh'))
      .mockResolvedValue(undefined)
    await render('product_intake', onSubmit)
    await fill(
      'workflow-deliverable-acceptance_criteria-text',
      'User can save and reload the workflow'
    )
    await submit()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Stage changed; refresh'
    )
    expect(container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe(
      'User can save and reload the workflow'
    )
    await submit()
    expect(onSubmit).toHaveBeenLastCalledWith(
      [
        {
          requirement_id: 'acceptance_criteria',
          kind: 'text',
          text: 'User can save and reload the workflow',
        },
      ],
      []
    )
  })

  it('submits each participant’s evidence separately while retaining file identities', async () => {
    const onSubmit = await render('qa_test')
    await fill('workflow-deliverable-qa_decision-text', 'Passed')
    await submit()
    expect(onSubmit).toHaveBeenCalledWith(
      [{ requirement_id: 'qa_decision', kind: 'text', text: 'Passed' }],
      []
    )
    const file = new File(['test results'], 'qa.txt', { type: 'text/plain' })
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>(
        '[data-testid="workflow-deliverable-test_evidence-file"]'
      )!
      Object.defineProperty(input, 'files', { value: [file], configurable: true })
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await submit()
    expect(onSubmit).toHaveBeenCalledWith(
      [{ requirement_id: 'qa_decision', kind: 'text', text: 'Passed' }],
      [{ requirementId: 'test_evidence', kind: 'file', file }]
    )
  })

  it('permits a PR instead of a code snapshot and locks release evidence to merged', async () => {
    await render('dev_implementation')
    const select = container.querySelector<HTMLSelectElement>(
      '[data-testid="workflow-deliverable-code_snapshot_or_pull_request-kind"]'
    )!
    await act(async () => {
      select.value = 'pull_request'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(
      container.querySelector(
        '[data-testid="workflow-deliverable-code_snapshot_or_pull_request-url"]'
      )
    ).not.toBeNull()
    act(() => root!.unmount())
    container.remove()
    root = undefined
    await render('merge_release')
    const state = container.querySelector<HTMLSelectElement>(
      '[data-testid="workflow-deliverable-merged_pull_request-state"]'
    )!
    expect(state.disabled).toBe(true)
    expect(state.value).toBe('merged')
  })
})
