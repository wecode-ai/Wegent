// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TemplateBindingsDialog } from './TemplateBindings'
import { builtinCollaborationTemplates } from './builtins'
import { templateFailureMessage } from './messages'

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

it.each([
  Object.assign(new Error('Expired session'), { status: 401 }),
  Object.assign(new Error('Insufficient permission'), { status: 403 }),
  Object.assign(new Error('Collaboration group name already exists in this owner scope'), {
    status: 409,
  }),
  Object.assign(new Error('Human is not available in this Project'), {
    status: 422,
  }),
  Object.assign(new Error('Internal Server Error'), { status: 500 }),
  new TypeError('Failed to fetch'),
])('shows the actionable apply failure and preserves role bindings: %s', async failure => {
  const template = structuredClone(builtinCollaborationTemplates()[0].document)
  const onApply = vi.fn().mockRejectedValue(failure)
  const onClose = vi.fn()
  await act(async () =>
    root.render(
      <TemplateBindingsDialog
        document={template}
        locale="zh-CN"
        candidates={[]}
        onApply={onApply}
        onClose={onClose}
      />
    )
  )
  const group = template.spec.resources.collaboration.groups[0]
  const selected = [...container.querySelectorAll<HTMLSelectElement>('select')].map(
    select => select.value
  )
  const apply = container.querySelector<HTMLButtonElement>(
    '[data-testid="template-bindings-apply"]'
  )!
  expect(apply.disabled).toBe(false)
  await act(async () => apply.click())
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    templateFailureMessage(failure, 'zh-CN')
  )
  expect(
    container.querySelector<HTMLInputElement>(`[data-testid="template-group-name-${group.key}"]`)!
      .value
  ).toBe(group.name)
  expect(
    [...container.querySelectorAll<HTMLSelectElement>('select')].map(select => select.value)
  ).toEqual(selected)
  expect(onClose).not.toHaveBeenCalled()
  expect(apply.disabled).toBe(false)
  expect(onApply).toHaveBeenCalledTimes(1)
})
