// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'

import { createCollaborationTranslator } from '../i18n'
import {
  ProjectSettingsReadBoundary,
  type ProjectSettingsReadControl,
} from './ProjectSettingsReadBoundary'

it('retains accepted drafts only within the same API scope and gates stale writes', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const save = vi.fn()
  const firstScope = {}
  const nextScope = {}
  function Draft() {
    const [value, setValue] = useState('initial')
    return (
      <>
        <input value={value} onChange={event => setValue(event.target.value)} />
        <button onClick={save}>Save</button>
      </>
    )
  }
  async function render(scope: object, status: ProjectSettingsReadControl['status']) {
    await act(async () =>
      root.render(
        <ProjectSettingsReadBoundary
          scope={scope}
          read={{ status, reload: vi.fn() }}
          translate={createCollaborationTranslator('en')}
        >
          <Draft />
        </ProjectSettingsReadBoundary>
      )
    )
  }
  try {
    await render(firstScope, 'loading')
    expect(container.querySelector('input')).toBeNull()
    await render(firstScope, 'ready')
    const input = container.querySelector('input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        'dirty'
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    for (const status of ['loading', 'error'] as const) {
      await render(firstScope, status)
      expect(container.querySelector('input')).toBe(input)
      expect(input.value).toBe('dirty')
      expect(container.querySelector('fieldset')?.hasAttribute('inert')).toBe(true)
      const button = container.querySelector('fieldset button') as HTMLButtonElement
      expect(button.matches(':disabled')).toBe(true)
      await act(async () => button.click())
      expect(save).not.toHaveBeenCalled()
    }
    await render(firstScope, 'ready')
    expect(container.querySelector('input')).toBe(input)
    await act(async () => (container.querySelector('fieldset button') as HTMLButtonElement).click())
    expect(save).toHaveBeenCalledTimes(1)
    await render(nextScope, 'loading')
    expect(container.querySelector('input')).toBeNull()
    await render(nextScope, 'ready')
    expect(container.querySelector('input')).not.toBe(input)
    expect(container.querySelector('input')?.value).toBe('initial')
  } finally {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})
