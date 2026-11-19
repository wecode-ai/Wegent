import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { ProjectAutomaticProcessing } from '@wegent/collaboration/project-manage'
import { createCollaborationTranslator } from '@wegent/collaboration'
import type {
  CollaborationAgent,
  CollaborationProject,
  SharedWorkspaceApi,
} from '@wegent/collaboration'

type Hook = Awaited<ReturnType<NonNullable<SharedWorkspaceApi['incomingHooks']>['list']>>[number]
const emptyAgents: CollaborationAgent[] = []
const hook = (id: string): Hook => ({
  id,
  projectId: 'project',
  name: id,
  status: 'active',
  version: 1,
  sourceType: 'github',
})

function fixture() {
  const hookList = vi.fn().mockResolvedValue([])
  const agentList = vi.fn().mockResolvedValue([{ id: 'agent', name: 'API Agent' }])
  const memberList = vi.fn().mockResolvedValue([])
  const groupList = vi.fn().mockResolvedValue([])
  const api = {
    automations: { list: vi.fn().mockResolvedValue([]) },
    projects: { listCollaborationGroups: groupList },
    agents: { list: agentList },
    members: { list: memberList },
    incomingHooks: { list: hookList },
  } as unknown as SharedWorkspaceApi
  return { api, hookList, agentList, memberList, groupList }
}
function panel(
  api: SharedWorkspaceApi,
  projectId = 'project',
  agents = emptyAgents,
  locale: 'en' | 'zh-CN' = 'en'
) {
  return (
    <ProjectAutomaticProcessing
      api={api}
      project={
        { id: projectId, name: projectId, access_role: 'Owner', version: 1 } as CollaborationProject
      }
      members={[]}
      agents={agents}
      locale={locale}
      translate={createCollaborationTranslator(locale)}
    />
  )
}
async function openEditor() {
  await waitFor(() => expect(screen.getByTestId('automatic-processing-create')).toBeEnabled())
  fireEvent.click(screen.getByTestId('automatic-processing-create'))
}
const external = () => fireEvent.click(screen.getByTestId('automatic-processing-trigger-external'))

it('loads hooks only for the external editor, retries failures and initializes each new read once', async () => {
  const f = fixture()
  const hooks = [hook('First hook')]
  f.hookList.mockRejectedValueOnce(new Error('Hooks offline')).mockResolvedValue(hooks)
  render(panel(f.api))
  await openEditor()
  expect(f.hookList).not.toHaveBeenCalled()
  external()
  fireEvent.click(await screen.findByTestId('automatic-processing-hooks-retry'))
  await waitFor(() =>
    expect(screen.getByTestId('automatic-processing-hook')).toHaveValue(hooks[0].id)
  )
  fireEvent.change(screen.getByTestId('automatic-processing-hook'), { target: { value: '' } })
  expect(screen.getByTestId('automatic-processing-hook')).toHaveValue('')
  fireEvent.click(screen.getByTestId('automatic-processing-trigger-created'))
  external()
  await waitFor(() => expect(f.hookList).toHaveBeenCalledTimes(3))
  await waitFor(() =>
    expect(screen.getByTestId('automatic-processing-hook')).toHaveValue(hooks[0].id)
  )
})

it('clears a prior API hook catalog even if both APIs share the same hook transport', async () => {
  const f = fixture()
  f.hookList.mockResolvedValueOnce([hook('Old hook')])
  const view = render(panel(f.api))
  await openEditor()
  external()
  await waitFor(() =>
    expect(screen.getByTestId('automatic-processing-hook')).toHaveValue('Old hook')
  )
  let finish!: (hooks: Hook[]) => void
  f.hookList.mockImplementationOnce(
    () =>
      new Promise<Hook[]>(resolve => {
        finish = resolve
      })
  )
  view.rerender(panel({ ...f.api }))
  expect(screen.queryByTestId('automatic-processing-form')).not.toBeInTheDocument()
  await openEditor()
  external()
  expect(screen.queryByRole('option', { name: 'Old hook' })).not.toBeInTheDocument()
  await act(async () => finish([hook('New hook')]))
  expect(screen.getByTestId('automatic-processing-hook')).toHaveValue('New hook')
})

it('accepts newer agent props without repeating candidate requests', async () => {
  const f = fixture()
  const view = render(panel(f.api))
  await openEditor()
  view.rerender(
    panel(f.api, 'project', [{ id: 'new-agent', name: 'New agent' } as CollaborationAgent])
  )
  fireEvent.click(screen.getByTestId('automatic-processing-target'))
  expect(screen.getByTestId('automatic-processing-target-option-agent-new-agent')).toBeVisible()
  expect(
    screen.queryByTestId('automatic-processing-target-option-agent-agent')
  ).not.toBeInTheDocument()
  expect(f.agentList).toHaveBeenCalledOnce()
  expect(f.memberList).toHaveBeenCalledOnce()
  expect(f.groupList).toHaveBeenCalledOnce()
})

it('does not replace another project hook selection with a late response', async () => {
  const f = fixture()
  let finish!: (hooks: Hook[]) => void
  f.hookList
    .mockImplementationOnce(
      () =>
        new Promise<Hook[]>(resolve => {
          finish = resolve
        })
    )
    .mockResolvedValueOnce([hook('Other project hook')])
  const view = render(panel(f.api))
  await openEditor()
  external()
  view.rerender(panel(f.api, 'other-project'))
  await openEditor()
  external()
  await waitFor(() =>
    expect(screen.getByTestId('automatic-processing-hook')).toHaveValue('Other project hook')
  )
  await act(async () => finish([hook('Old project hook')]))
  expect(screen.getByTestId('automatic-processing-hook')).toHaveValue('Other project hook')
  expect(screen.queryByRole('option', { name: 'Old project hook' })).not.toBeInTheDocument()
  expect(f.hookList).toHaveBeenLastCalledWith('other-project')
})

it('updates a generic candidate failure translation without reloading the candidate APIs', async () => {
  const f = fixture()
  f.memberList.mockRejectedValue({ code: 'unavailable' })
  const view = render(panel(f.api))
  await screen.findByRole('alert')
  view.rerender(panel(f.api, 'project', emptyAgents, 'zh-CN'))
  expect(screen.getByRole('alert')).toHaveTextContent(
    createCollaborationTranslator('zh-CN')(
      'todo.automatic_processing_load_failed',
      '加载自动处理失败'
    )
  )
  expect(f.agentList).toHaveBeenCalledOnce()
  expect(f.memberList).toHaveBeenCalledOnce()
  expect(screen.getByTestId('automatic-processing-create')).toBeDisabled()
})
