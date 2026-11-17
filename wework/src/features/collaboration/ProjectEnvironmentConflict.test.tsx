// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createDeliveryApi, type CloudProject } from '@/api/deliveries'
import { createHttpClient } from '@/api/http'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createCollaborationTranslator, type SharedWorkspaceApi } from '@wegent/collaboration'
import { ProjectExecutionEnvironments } from '@wegent/collaboration/project-manage'
import { afterEach, expect, it, vi } from 'vitest'

import { createWeworkDeliverySharedWorkspaceApi } from './weworkSharedWorkspaceApi'

const prefix = 'collaboration-project-execution-environment'
const project: CloudProject = {
  id: 'conflict-project',
  public_id: 'conflict-project',
  project_key: 'CONFLICT',
  name: 'Conflict project',
  description: '',
  project_store: 'backend',
  task_provider: 'local',
  provider_config: {},
  access_role: 'Owner',
  created_by_user_id: 1,
  status: 'active',
  tags: [],
  version: 1,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  execution_environment: { workspace_policy: 'git_worktree', repositories: [], setup_steps: [] },
}

afterEach(() => vi.unstubAllGlobals())

it.each([
  ['version_conflict', 'Reload the project and retry with its current version'],
  ['idempotency_conflict', 'Use a different operation identifier'],
  ['partial_reference_conflict', 'Remove the referenced resource first'],
  ['network', 'Failed to fetch'],
] as const)(
  'handles %s through the real HTTP and project adapter boundary',
  async (code, message) => {
    const latest: CloudProject = {
      ...project,
      description: 'Concurrent description',
      version: 3,
      execution_environment: {
        ...project.execution_environment!,
        setup_steps: [{ command: 'printf concurrent-edit', working_directory: '' }],
      },
    }
    const writes: Array<Record<string, unknown>> = []
    const fetch = vi.fn(async (url: string, options: RequestInit) => {
      const path = new URL(url).pathname
      if (options.method === 'PATCH' && path === `/api/v1/cloud-projects/${project.id}`) {
        writes.push(JSON.parse(options.body as string))
        if (writes.length === 1) {
          if (code === 'network') throw new TypeError(message)
          return new Response(
            JSON.stringify({ error_code: 409, detail: { reason_code: code, message } }),
            { status: 409 }
          )
        }
        return new Response(
          JSON.stringify({
            ...latest,
            version: 4,
            execution_environment: writes.at(-1)!.execution_environment,
          })
        )
      }
      if (options.method === 'GET' && path === `/api/v1/projects/${project.id}`) {
        return new Response(JSON.stringify(latest))
      }
      throw new Error(`Unexpected request ${options.method} ${path}`)
    })
    vi.stubGlobal('fetch', fetch)
    const client = createHttpClient({ baseUrl: 'https://example.test/api', getToken: () => null })
    const adapter = createWeworkDeliverySharedWorkspaceApi(createDeliveryApi(client))
    const api = {
      ...adapter,
      projects: { ...adapter.projects, listExecutionEnvironments: vi.fn(async () => []) },
    } as unknown as SharedWorkspaceApi
    render(
      <ProjectExecutionEnvironments
        api={api}
        project={project}
        translate={createCollaborationTranslator('zh-CN')}
      />
    )
    fireEvent.click(screen.getByTestId(`${prefix}-preparation-toggle`))
    const policy = screen.getByTestId(`${prefix}-workspace-policy`)
    fireEvent.change(policy, { target: { value: 'project' } })
    const save = screen.getByTestId(`${prefix}-save-configuration`)
    fireEvent.click(save)
    const error = await screen.findByTestId(`${prefix}-configuration-error`)

    if (code !== 'version_conflict') {
      await waitFor(() => expect(save).toBeEnabled())
      expect(error).toHaveTextContent(code === 'network' ? '无法连接服务' : message)
      expect(screen.queryByTestId(`${prefix}-rebase-configuration`)).toBeNull()
      expect(fetch).toHaveBeenCalledTimes(1)
      return
    }
    expect(error).toHaveTextContent('草稿尚未保存')
    expect(save).toBeDisabled()
    expect(policy).toHaveValue('project')
    expect(writes).toEqual([
      {
        version: 1,
        execution_environment: { workspace_policy: 'project', repositories: [], setup_steps: [] },
      },
    ])
    fireEvent.click(screen.getByTestId(`${prefix}-rebase-configuration`))
    expect(await screen.findByTestId(`${prefix}-configuration-notice`)).toHaveTextContent(
      '草稿尚未保存'
    )
    expect(policy).toHaveValue('project')
    expect(writes).toHaveLength(1)
    fireEvent.click(save)
    expect(await screen.findByTestId(`${prefix}-configuration-status`)).toHaveTextContent(
      '配置已保存'
    )
    expect(writes).toEqual([
      {
        version: 1,
        execution_environment: { workspace_policy: 'project', repositories: [], setup_steps: [] },
      },
      {
        version: 3,
        execution_environment: { workspace_policy: 'project', repositories: [], setup_steps: [] },
      },
    ])
  }
)
