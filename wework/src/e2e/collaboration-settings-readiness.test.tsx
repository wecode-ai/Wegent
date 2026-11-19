import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Activity, useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { CollaborationApp } from '../../../packages/collaboration/src/CollaborationApp'
import type { SharedWorkspaceApi } from '../../../packages/collaboration/src/ports/SharedWorkspaceApi'
import {
  RetainedProjectSettingsPages,
  type ProjectSettingsPagesProps,
} from '../../../packages/collaboration/src/project-manage/ProjectSettingsPages'
import type {
  CollaborationLocation,
  CollaborationProject,
} from '../../../packages/collaboration/src/types'
import type { DesktopControlCommand } from '@/extensions/desktop-control-contract'
import { addProjectTag } from '../../e2e/desktop/modules/collaboration-settings-ux.mjs'
import { runDesktopControlClient } from './automation'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function nativeControl() {
  let next: DesktopControlCommand | undefined
  const commands: DesktopControlCommand[] = []
  const results: Array<{ ok: boolean; value?: string; error?: string }> = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url.includes('/commands?')) {
      const command = next
      next = undefined
      return command ? Response.json(command) : new Response(null, { status: 410 })
    }
    if (url.endsWith('/results')) results.push(JSON.parse(String(init?.body)))
    return Response.json({})
  })
  return {
    commands,
    async command(action: DesktopControlCommand['action'], selector: string, options = {}) {
      next = { id: 'settings-readiness', action, selector, timeoutMs: 500, ...options }
      commands.push(next)
      const index = results.length
      await runDesktopControlClient('http://127.0.0.1:43111', 'main')
      await act(async () => {})
      const result = results[index]
      if (!result?.ok) throw new Error(result?.error ?? 'Missing control result')
      return result.value ?? ''
    },
  }
}

function RetainedPages(props: ProjectSettingsPagesProps) {
  return <RetainedProjectSettingsPages {...props} boundary={Activity} />
}

async function mountSettings() {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(10, 10, 200, 30)
  )
  const project = {
    id: 'project-a',
    name: 'Project A',
    project_key: 'A',
    project_store: 'local',
    task_provider: 'local',
    provider_config: {},
    access_role: 'Owner',
    tags: [],
    version: 1,
  } as unknown as CollaborationProject
  const api = {
    projects: {
      get: vi.fn(async () => project),
      list: vi.fn(async () => [project]),
      listExecutionEnvironments: vi.fn(async () => []),
      update: vi.fn(async (_id: string, values: { version: number; tags: string[] }) => ({
        ...project,
        ...values,
        version: values.version + 1,
      })),
    },
    resources: { devices: { local: vi.fn(async () => []) } },
    issues: {
      listPage: vi.fn(async () => ({ items: [], taskBindings: [], nextCursor: null })),
      getBoardSnapshot: vi.fn(async () => ({
        items: [],
        members: [],
        agents: [],
        taskBindings: [],
      })),
    },
  }
  function Host() {
    const [location, navigate] = useState<CollaborationLocation>({
      projectId: project.id,
      issueId: null,
      view: 'manage',
      projectSettingsSection: 'project',
    })
    return (
      <CollaborationApp
        api={api as unknown as SharedWorkspaceApi}
        initialProject={project}
        pollIntervalMs={0}
        host={{ location, navigate, capabilities: {}, settingsPages: RetainedPages }}
      />
    )
  }
  render(<Host />)
  await waitFor(() =>
    expect(screen.getByTestId('cloud-project-manage-tags').closest('[inert]')).toBeNull()
  )
  fireEvent.click(screen.getByTestId('collaboration-project-settings-environments'))
  await act(async () => {})
  const current = deferred<CollaborationProject>()
  api.projects.get.mockReturnValueOnce(current.promise)
  return { api, project, current, control: nativeControl() }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('waits for the current project version before opening retained tag settings and saving', async () => {
  const { api, project, current, control } = await mountSettings()
  const tags = screen.getByTestId('cloud-project-manage-tags')
  const result = addProjectTag(control, (selector: string) => selector, 'fresh-version').catch(
    (error: Error) => error
  )
  await waitFor(() => expect(tags.closest('[inert]')).not.toBeNull())
  await waitFor(() => expect(api.projects.get).toHaveBeenCalledTimes(3))
  await waitFor(() =>
    expect(control.commands.some(command => command.selector?.endsWith(' > summary'))).toBe(true)
  )
  await act(async () => {})
  expect(api.projects.update).not.toHaveBeenCalled()
  await act(async () => current.resolve({ ...project, version: 7 }))
  expect(await result).toBeUndefined()
  expect(screen.getByTestId('cloud-project-manage-tags')).toBe(tags)
  expect(screen.getByTestId('cloud-project-tag-fresh-version')).toBeVisible()
  expect(api.projects.update).toHaveBeenCalledWith(
    project.id,
    expect.objectContaining({ version: 7, tags: ['fresh-version'] })
  )
})

it.each(['read failure', 'permission revoked'] as const)(
  'does not mutate the retained project after %s',
  async condition => {
    const { api, project, current, control } = await mountSettings()
    const result = addProjectTag(control, (selector: string) => selector, 'forbidden').catch(
      (error: Error) => error
    )
    await waitFor(() =>
      expect(screen.getByTestId('cloud-project-manage-tags').closest('[inert]')).not.toBeNull()
    )
    await waitFor(() => expect(api.projects.get).toHaveBeenCalledTimes(3))
    await act(async () => {
      if (condition === 'read failure') current.reject(new Error('Current read failed'))
      else current.resolve({ ...project, access_role: 'Viewer', version: 7 })
    })
    expect(await result).toBeInstanceOf(Error)
    expect(api.projects.update).not.toHaveBeenCalled()
    if (condition === 'read failure')
      expect(screen.getByTestId('collaboration-project-settings-read')).toHaveAttribute(
        'role',
        'alert'
      )
  }
)
