// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCollaborationTranslator } from '../i18n'
import type { CollaborationIssue, CollaborationMember } from '../types'
import { IssueIntakeForm } from './IssueIntakeForm'

let root: Root | undefined
let container: HTMLDivElement
const definition = {
  objective: 'A clear goal',
  scope: 'Included behavior',
  non_goals: 'Excluded behavior',
  acceptance_criteria: 'Observable result',
  dependencies: 'none',
  proposed_owner: 'product-owner',
}
async function render(complete = false) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  const onSave = vi.fn(async () => ({ version: 9 }) as CollaborationIssue)
  const onAdmit = vi.fn(async () => undefined)
  await act(async () =>
    root!.render(
      <IssueIntakeForm
        issue={
          {
            priority: complete ? 'high' : 'none',
            ...(complete ? { intake_definition: definition } : {}),
          } as CollaborationIssue
        }
        members={
          [{ user_id: 7, user_name: 'product-owner', role: 'Developer' }] as CollaborationMember[]
        }
        editable
        translate={createCollaborationTranslator('en')}
        onSave={onSave}
        onAdmit={onAdmit}
      />
    )
  )
  return { onSave, onAdmit }
}
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  container?.remove()
})

describe('inbox definition and admission', () => {
  it('permits incomplete backlog saving while preventing premature admission', async () => {
    const { onSave, onAdmit } = await render()
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="issue-intake-admit"]')!.disabled
    ).toBe(true)
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="issue-intake-save"]')!.click()
    )
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ objective: '', proposed_owner: '' }),
      'none'
    )
    expect(onAdmit).not.toHaveBeenCalled()
    expect(container.textContent).toContain('starts no stage tasks or assistants')
  })

  it('saves before admission using the returned issue version and a stable key on retry', async () => {
    const { onSave, onAdmit } = await render(true)
    onAdmit.mockRejectedValueOnce(new Error('Evidence changed'))
    const button = container.querySelector<HTMLButtonElement>('[data-testid="issue-intake-admit"]')!
    await act(async () => button.click())
    expect(onSave).toHaveBeenCalledWith(definition, 'high')
    expect(onAdmit).toHaveBeenCalledWith(9, expect.any(String))
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Evidence changed')
    expect(container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe(
      definition.objective
    )
    await act(async () => button.click())
    expect(onAdmit.mock.calls[0][1]).toBe(onAdmit.mock.calls[1][1])
    expect(onAdmit.mock.calls[1][0]).toBe(9)
    expect(onSave).toHaveBeenCalledTimes(1)
  })
})
