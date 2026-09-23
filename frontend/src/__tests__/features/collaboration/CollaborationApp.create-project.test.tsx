// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import {
  CollaborationApp,
  type CollaborationHostAdapter,
  type CollaborationProject,
  type SharedWorkspaceApi,
} from '@wegent/collaboration'

const createdProject: CollaborationProject = {
  id: 'project-created',
  public_id: 'WEB',
  project_key: 'WEB',
  name: 'Web GitLab board',
  description: 'Web cloud project',
  project_store: 'backend',
  task_provider: 'gitlab',
  provider_config: { repository: 'group/project' },
  created_by_user_id: 1,
  visibility: 'public',
  status: 'active',
  tags: [],
  version: 1,
  created_at: '2026-09-10T00:00:00Z',
  updated_at: '2026-09-10T00:00:00Z',
}

describe('CollaborationApp shared project creation', () => {
  function homeApi() {
    return {
      projects: {
        list: jest.fn().mockResolvedValue([]),
      },
    } as unknown as SharedWorkspaceApi
  }

  function homeHost(): CollaborationHostAdapter {
    return {
      capabilities: {
        automation: true,
        dingtalkAitable: false,
      },
      location: {
        projectId: null,
        issueId: null,
        view: 'board',
        rootView: 'home',
      },
      navigate: jest.fn(),
    }
  }

  it('renders the shared home in English without Chinese text and in Chinese without raw keys', async () => {
    const english = render(
      <CollaborationApp api={homeApi()} host={homeHost()} locale="en" pollIntervalMs={0} />
    )
    await screen.findByRole('heading', { name: 'Project spaces' })
    expect(english.container.textContent).not.toMatch(/\p{Script=Han}/u)
    english.unmount()

    const chinese = render(
      <CollaborationApp api={homeApi()} host={homeHost()} locale="zh-CN" pollIntervalMs={0} />
    )
    await screen.findByRole('heading', { name: '项目空间' })
    expect(chinese.container.textContent).not.toMatch(/\b(?:todo|common)\.[a-z0-9_.-]+\b/i)
  })

  it('uses the full shared cloud form and hides unavailable local and AITable capabilities', async () => {
    const create = jest.fn().mockResolvedValue(createdProject)
    const api = {
      projects: {
        list: jest.fn().mockResolvedValue([]),
        create,
      },
    } as unknown as SharedWorkspaceApi
    const navigate = jest.fn()
    const host: CollaborationHostAdapter = {
      capabilities: {
        automation: true,
        dingtalkAitable: false,
      },
      location: {
        projectId: null,
        issueId: null,
        view: 'board',
        rootView: 'home',
      },
      navigate,
    }

    render(<CollaborationApp api={api} host={host} locale="zh-CN" pollIntervalMs={0} />)

    fireEvent.click(await screen.findByTestId('collaboration-project-create'))

    expect(screen.queryByTestId('cloud-project-location-cloud')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cloud-project-location-local')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('collaboration-project-create-advanced'))
    expect(screen.getByTestId('cloud-project-task-provider-local')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-project-task-provider-github')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-project-task-provider-gitlab')).toBeInTheDocument()
    expect(
      screen.queryByTestId('cloud-project-task-provider-dingtalk_aitable')
    ).not.toBeInTheDocument()

    fireEvent.change(screen.getByTestId('collaboration-project-name-input'), {
      target: { value: ' Web GitLab board ' },
    })
    fireEvent.click(screen.getByTestId('cloud-project-visibility-public'))
    fireEvent.click(screen.getByTestId('cloud-project-task-provider-gitlab'))
    fireEvent.change(screen.getByTestId('cloud-project-provider-repository'), {
      target: { value: 'group/project' },
    })
    fireEvent.change(screen.getByTestId('cloud-project-provider-token'), {
      target: { value: 'gitlab-secret' },
    })
    fireEvent.change(screen.getByTestId('collaboration-project-description-input'), {
      target: { value: ' Web cloud project ' },
    })
    fireEvent.click(screen.getByTestId('collaboration-project-create-confirm'))

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        name: 'Web GitLab board',
        description: 'Web cloud project',
        taskProvider: 'gitlab',
        providerConfig: {
          repository: 'group/project',
          token: 'gitlab-secret',
        },
        visibility: 'public',
      })
    )
    expect(navigate).toHaveBeenCalledWith({
      projectId: createdProject.id,
      issueId: null,
      view: 'board',
    })
  })

  it('creates a built-in project with related-task visibility', async () => {
    const create = jest.fn().mockResolvedValue({
      ...createdProject,
      task_provider: 'local',
      provider_config: {},
      visibility: 'public_restricted',
    })
    const api = {
      projects: {
        list: jest.fn().mockResolvedValue([]),
        create,
      },
    } as unknown as SharedWorkspaceApi
    const host = homeHost()

    render(<CollaborationApp api={api} host={host} locale="zh-CN" pollIntervalMs={0} />)

    fireEvent.click(await screen.findByTestId('collaboration-project-create'))
    fireEvent.change(screen.getByTestId('collaboration-project-name-input'), {
      target: { value: ' Related tasks ' },
    })
    fireEvent.click(screen.getByTestId('cloud-project-visibility-public-restricted'))
    fireEvent.click(screen.getByTestId('collaboration-project-create-confirm'))

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        name: 'Related tasks',
        description: '',
        taskProvider: 'local',
        providerConfig: {},
        visibility: 'public_restricted',
      })
    )
  })

  it('hides related-task visibility for external providers', async () => {
    render(<CollaborationApp api={homeApi()} host={homeHost()} locale="zh-CN" pollIntervalMs={0} />)

    fireEvent.click(await screen.findByTestId('collaboration-project-create'))
    fireEvent.click(screen.getByTestId('collaboration-project-create-advanced'))
    expect(screen.getByTestId('cloud-project-visibility-public-restricted')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('cloud-project-task-provider-github'))

    expect(
      screen.queryByTestId('cloud-project-visibility-public-restricted')
    ).not.toBeInTheDocument()
    expect(screen.getByTestId('cloud-project-visibility-private')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
  })
})
