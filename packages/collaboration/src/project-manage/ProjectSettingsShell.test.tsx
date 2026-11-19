// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Activity, act, useCallback, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ProjectSettingsShell } from './ProjectSettingsShell'
import {
  RetainedProjectSettingsPages,
  type ProjectSettingsPagesProps,
} from './ProjectSettingsPages'

const RetainedPages = (props: ProjectSettingsPagesProps) => (
  <RetainedProjectSettingsPages {...props} boundary={Activity} />
)

let container: HTMLDivElement
let root: Root

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

it('retains drafts while pausing hidden-page effects and never mounts unvisited pages', async () => {
  const started = vi.fn()
  const stopped = vi.fn()
  function Page({ id }: { id: string }) {
    const [draft, setDraft] = useState('')
    const observeInput = useCallback(
      (element: HTMLInputElement | null) => {
        if (!element) return
        started(id)
        return () => stopped(id)
      },
      [id]
    )
    return (
      <input
        ref={observeInput}
        data-testid={`draft-${id}`}
        value={draft}
        onChange={event => setDraft(event.target.value)}
      />
    )
  }
  const render = (selected = 'environment', scope = 'project-a') =>
    act(async () => {
      root.render(
        <ProjectSettingsShell
          pageRenderer={RetainedPages}
          scopeKey={scope}
          ariaLabel="Settings"
          selectedSectionId={selected}
          sections={['environment', 'groups', 'members'].map(id => ({
            id,
            label: id,
            testId: `nav-${id}`,
            content: <Page id={id} />,
          }))}
        />
      )
    })
  await render()
  const frame = container.querySelector('[data-testid="project-settings-shell-content"]')!
  const input = container.querySelector<HTMLInputElement>('[data-testid="draft-environment"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      'pnpm install'
    )
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(started.mock.calls).toEqual([['environment']])
  await render('groups')
  expect(stopped).toHaveBeenCalledWith('environment')
  expect(started).not.toHaveBeenCalledWith('members')
  expect(
    input.closest('[data-testid="project-settings-shell-page-environment"]')?.getAttribute('style')
  ).toContain('display: none')
  await render()
  expect(container.querySelector('[data-testid="draft-environment"]')).toBe(input)
  expect(input.value).toBe('pnpm install')
  await render('environment', 'project-b')
  expect(frame.isConnected).toBe(true)
  expect(container.querySelector('[data-testid="project-settings-shell-content"]')).toBe(frame)
  expect(
    container.querySelector<HTMLInputElement>('[data-testid="draft-environment"]')!.value
  ).toBe('')
})
