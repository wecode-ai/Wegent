// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

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
    for (const [locale, heading, invalidText] of [
      ['en', 'Project spaces', /\p{Script=Han}/u],
      ['zh-CN', '项目空间', /\b(?:todo|common)\.[a-z0-9_.-]+\b/i],
    ] as const) {
      const api = homeApi()
      let view!: ReturnType<typeof render>
      // The directory is a resolved mock promise; flush that render rather than polling timers.
      await act(async () => {
        view = render(
          <CollaborationApp api={api} host={homeHost()} locale={locale} pollIntervalMs={0} />
        )
      })
      expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument()
      expect(view.container.textContent).not.toMatch(invalidText)
      view.unmount()
    }
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
        publicAccess: { role: 'Viewer' },
        defaultIssueSecurity: 'open',
      })
    )
    expect(navigate).toHaveBeenCalledWith({
      projectId: createdProject.id,
      issueId: null,
      view: 'board',
    })
  })

  it('creates a public built-in project with related issue security', async () => {
    const create = jest.fn().mockResolvedValue({
      ...createdProject,
      task_provider: 'local',
      provider_config: {},
      visibility: 'public',
      public_access: { role: 'Viewer' },
      default_issue_security: 'related',
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
    fireEvent.click(screen.getByTestId('cloud-project-visibility-public'))
    fireEvent.click(screen.getByTestId('cloud-project-default-issue-security-related'))
    fireEvent.click(screen.getByTestId('collaboration-project-create-confirm'))

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        name: 'Related tasks',
        description: '',
        taskProvider: 'local',
        providerConfig: {},
        visibility: 'public',
        publicAccess: { role: 'Viewer' },
        defaultIssueSecurity: 'related',
      })
    )
  })

  it('keeps issue security available for GitHub projects', async () => {
    render(<CollaborationApp api={homeApi()} host={homeHost()} locale="zh-CN" pollIntervalMs={0} />)

    fireEvent.click(await screen.findByTestId('collaboration-project-create'))
    fireEvent.click(screen.getByTestId('collaboration-project-create-advanced'))
    expect(screen.getByTestId('cloud-project-default-issue-security-related')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('cloud-project-task-provider-github'))

    expect(screen.getByTestId('cloud-project-default-issue-security-related')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-project-visibility-private')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
  })
})
