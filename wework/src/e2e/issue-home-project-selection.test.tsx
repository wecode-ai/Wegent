import '@/i18n'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createRef, useState, type ComponentProps } from 'react'
import type { IssueHomeTaskComposerProps } from '@wegent/collaboration/platform'
import { afterEach, expect, it, vi } from 'vitest'
import { WeworkIssueHomeComposer } from '@/features/todo/WeworkIssueHomeComposer'
import { PersonalHomeTaskComposer } from '@/features/todo/PersonalHomeTaskComposer'
import type { PersonalHomeTaskDrafts } from '@/features/todo/personalHomeTaskDrafts'
import type { DesktopControlCommand } from '@/extensions/desktop-control-contract'
import { selectIssueHomeComposerProject } from '../../e2e/desktop/scenarios/collaboration-issue-task-discovery.scenario.mjs'
import { runDesktopControlClient } from './automation'

const mocks = vi.hoisted(() => ({ workbench: vi.fn() }))
vi.mock('@/features/workbench/useWorkbench', async importOriginal => ({
  ...(await importOriginal<typeof import('@/features/workbench/useWorkbench')>()),
  useWorkbench: mocks.workbench,
}))
vi.mock('@/api/dsh/desktopHost', () => ({ invokeDesktopHost: vi.fn(async () => ({})) }))

function nativeControl() {
  let next: DesktopControlCommand | undefined
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
    command: async (action: DesktopControlCommand['action'], selector: string, options = {}) => {
      next = { id: 'issue-home-project-selection', action, selector, ...options }
      const resultIndex = results.length
      await act(async () => runDesktopControlClient('http://127.0.0.1:43111', 'main'))
      const result = results[resultIndex]
      if (!result?.ok) throw new Error(result?.error ?? 'Missing control result')
      return result.value ?? ''
    },
  }
}

function mountComposer() {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(10, 10, 200, 30)
  )
  const issue = {
    id: 'prepared-issue',
    cloud_project_id: 'p1',
    title: 'Keep the unfinished work',
    description: 'Keep the unfinished work',
    status: 'pending',
    version: 1,
    tags: [],
  }
  const createIssue = vi.fn(async () => issue)
  const bindTask = vi.fn().mockRejectedValue(new Error('Binding transport disconnected'))
  const createProjectRuntimeTask = vi.fn(async (_message, options) => {
    await options.prepareRuntimeTask({ deviceId: 'device', taskId: 'task' })
    throw new Error('Rejected binding must prevent execution')
  })
  const model = { name: 'test-model', type: 'public' }
  mocks.workbench.mockReturnValue({
    state: { user: { id: 7 }, projects: [], devices: [], currentProject: null },
    projectChat: {
      models: [model],
      skills: [],
      selectedModel: model,
      selectedModelOptions: {},
      selectedSkills: [],
      isModelSelectionReady: true,
      isOptionsLocked: false,
      setSelectedModel: vi.fn(),
      setSelectedModelOption: vi.fn(),
      toggleSkill: vi.fn(),
      listLocalSkills: vi.fn(async () => []),
    },
    projectExecutionMode: 'current_workspace',
    createProjectRuntimeTask,
  })
  const drafts: PersonalHomeTaskDrafts = new Map()
  const taskProps = {
    api: {
      issues: {
        create: createIssue,
        get: vi.fn(async () => issue),
        update: vi.fn(async () => issue),
      },
    },
    services: { workspaceRuntimePort: { bindTask, unbindTask: vi.fn() } },
    drafts,
  } as unknown as Omit<ComponentProps<typeof PersonalHomeTaskComposer>, 'draft'>
  function Host() {
    const [projectId, setProjectId] = useState('p1')
    const [value, setValue] = useState(issue.description)
    const props: IssueHomeTaskComposerProps = {
      ref: createRef(),
      projectId,
      projects: [
        { id: 'p1', name: 'First project', project_store: 'backend' },
        { id: 'p2', name: 'Second project', project_store: 'backend' },
      ] as IssueHomeTaskComposerProps['projects'],
      onSelectProject: setProjectId,
      value,
      onChange: setValue,
      onSubmit: vi.fn(async () => true),
      disabled: false,
      placeholder: 'Describe the work',
      projectLabel: 'Project',
      error: null,
      members: [],
      attachments: [],
      onFileSelect: vi.fn(),
      onRemoveAttachment: vi.fn(),
      onRemovePendingFile: vi.fn(),
    }
    return (
      <>
        <style>{'.hidden { display: none }'}</style>
        <WeworkIssueHomeComposer
          {...props}
          renderTaskComposer={draft => <PersonalHomeTaskComposer {...taskProps} draft={draft} />}
        />
      </>
    )
  }
  render(<Host />)
  return { issue, drafts, createIssue, bindTask }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('switches the visible composer project after a rejected start and restores its own prepared Issue', async () => {
  const { issue, createIssue, bindTask } = mountComposer()
  const control = nativeControl()
  const scope = (selector: string) => `[data-testid="collaboration-issue-workspace"] ${selector}`
  await selectIssueHomeComposerProject(control, scope, 'p1')
  fireEvent.click(screen.getByTestId('personal-home-new-issue'))
  expect(screen.getByTestId('personal-home-task-content')).toHaveTextContent(issue.description)
  await control.command('click', '[data-testid="personal-home-start-task"]')
  await waitFor(() => expect(createIssue).toHaveBeenCalledOnce())
  await waitFor(() => expect(screen.getByTestId('personal-home-start-task')).toBeEnabled())
  expect(bindTask).toHaveBeenCalledOnce()
  expect(screen.getByTestId('personal-home-task-draft')).toHaveAttribute('data-issue-id', issue.id)

  const triggers = screen.getAllByTestId('collaboration-issue-project-trigger')
  expect(triggers).toHaveLength(2)
  expect(triggers[0]).not.toBeVisible()
  expect(triggers[0].closest('[inert]')).not.toBeNull()
  expect(triggers[1]).toBeVisible()
  expect(triggers[1]).toBeEnabled()
  expect(triggers[1].closest('[inert]')).toBeNull()

  await selectIssueHomeComposerProject(control, scope, 'p2')
  expect(screen.queryByTestId('personal-home-task-draft')).not.toBeInTheDocument()
  expect(screen.getByTestId('personal-home-task-content')).toHaveTextContent(issue.description)
  await selectIssueHomeComposerProject(control, scope, 'p1')
  expect(screen.getByTestId('personal-home-task-draft')).toHaveAttribute('data-issue-id', issue.id)
  expect(screen.getByTestId('personal-home-task-content')).toHaveTextContent(issue.description)
  expect(createIssue).toHaveBeenCalledOnce()
})
