import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { ProjectManageView } from '../../../../packages/collaboration/src/project-manage/ProjectManageView'
import type {
  ProjectManageApi,
  ProjectManageHost,
  ProjectManageItem,
  ProjectManageMember,
  ProjectManageProject,
  ProjectManageUser,
} from '../../../../packages/collaboration/src/project-manage/types'

const Icon = () => null
const host: ProjectManageHost = {
  icons: {
    Check: Icon,
    GitBranch: Icon,
    LockKeyhole: Icon,
    Pencil: Icon,
    Search: Icon,
    Trash2: Icon,
    X: Icon,
  },
  translate: (_key, fallback) => fallback,
  confirm: () => true,
  trackCompleted: vi.fn(),
  trackFailed: vi.fn(),
  renderTooltip: ({ children }) => children,
  renderActionMenu: () => null,
}
const project: ProjectManageProject = {
  id: 'project-1',
  name: 'Project',
  description: '',
  project_key: 'PR',
  access_role: 'Maintainer',
  task_provider: 'github',
  provider_config: { repository: 'org/original' },
  tags: [],
  version: 1,
}
function createApi() {
  return {
    listMembers: vi.fn(async () => []),
    listItems: vi.fn(async () => ({ items: [] })),
    updateProject: vi.fn(),
  } as unknown as ProjectManageApi<
    ProjectManageProject,
    ProjectManageMember,
    ProjectManageItem,
    ProjectManageUser
  >
}

test('preserves repository and token drafts across metadata versions and resets them for another API owner', () => {
  const api = createApi()
  const nextApi = createApi()
  const { rerender } = render(
    <ProjectManageView api={api} host={host} project={project} section="overview" />
  )
  fireEvent.change(screen.getByTestId('cloud-project-provider-manage-repository'), {
    target: { value: 'https://github.com/org/draft' },
  })
  fireEvent.change(screen.getByTestId('cloud-project-provider-manage-token'), {
    target: { value: 'fixture-token' },
  })
  const incoming = { ...project, version: 2, provider_config: { repository: 'org/server' } }
  rerender(<ProjectManageView api={api} host={host} project={incoming} section="overview" />)
  expect(screen.getByTestId('cloud-project-provider-manage-repository')).toHaveValue(
    'https://github.com/org/draft'
  )
  expect(screen.getByTestId('cloud-project-provider-manage-token')).toHaveValue('fixture-token')
  rerender(<ProjectManageView api={nextApi} host={host} project={incoming} section="overview" />)
  expect(screen.getByTestId('cloud-project-provider-manage-repository')).toHaveValue(
    'https://github.com/org/server'
  )
  expect(screen.getByTestId('cloud-project-provider-manage-token')).toHaveValue('')
  expect(nextApi.listMembers).not.toHaveBeenCalled()
  expect(nextApi.listItems).not.toHaveBeenCalled()
})

test('updates clean fields from metadata and submits against the committed source version', async () => {
  const api = createApi()
  const onUpdated = vi.fn()
  const { rerender } = render(
    <ProjectManageView
      api={api}
      host={host}
      project={project}
      section="overview"
      onProjectUpdated={onUpdated}
    />
  )
  const incoming = { ...project, version: 6, provider_config: { repository: 'org/current' } }
  vi.mocked(api.updateProject).mockResolvedValue({ ...incoming, version: 7 })
  rerender(
    <ProjectManageView
      api={api}
      host={host}
      project={incoming}
      section="overview"
      onProjectUpdated={onUpdated}
    />
  )
  expect(screen.getByTestId('cloud-project-provider-manage-repository')).toHaveValue(
    'https://github.com/org/current'
  )
  fireEvent.click(screen.getByTestId('cloud-project-provider-manage-save'))
  await waitFor(() => expect(onUpdated).toHaveBeenCalledOnce())
  expect(api.updateProject).toHaveBeenCalledExactlyOnceWith(
    'project-1',
    expect.objectContaining({
      version: 6,
      provider_config: expect.objectContaining({ repository: 'org/current' }),
    })
  )
})
