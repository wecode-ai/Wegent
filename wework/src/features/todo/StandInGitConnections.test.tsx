import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { newStandInRole } from '@/api/personalStandIn'
import type { StandInExecutorApi } from '@/api/standIn'
import { StandInGitConnections } from './StandInGitConnections'

const provider = {
  id: '@wegent/dsh-connection-git/github',
  displayName: 'GitHub',
  resourceKinds: ['personal', 'repository'],
  dependencies: [],
  availability: { status: 'ready' },
}
const profile = JSON.stringify(['https://github.com', '7'])

describe('Git source connections', () => {
  const gitlabTarget = {
    pluginKey: 'gitlab',
    connectorSlug: `wework-gitlab-cli-${'a'.repeat(64)}`,
    instance: 'https://gitlab.company.example:8443',
  }

  function renderGitlabDiscovery(availability: unknown, nativeTarget = gitlabTarget) {
    const gitConnection = vi.fn(async (_device, input) => {
      if (input.channel === 'authTarget') return nativeTarget
      if (input.authOperation === 'start')
        return {
          status: 'waiting_browser',
          sessionId: 'gitlab-session',
          verificationUrl: `${gitlabTarget.instance}/oauth/device`,
          userCode: 'TEST-CODE',
        }
      return new Promise(() => undefined)
    })
    const searchConnectionResources = vi.fn(async () => ({ items: [], availability }))
    render(
      <StandInGitConnections
        role={newStandInRole('mac', 'developer')}
        provider={{ ...provider, id: '@wegent/dsh-connection-git/gitlab', displayName: 'GitLab' }}
        api={{ gitConnection, searchConnectionResources } as unknown as StandInExecutorApi}
        deviceId="mac"
        disabled={false}
        onChange={vi.fn()}
      />
    )
    fireEvent.change(screen.getByTestId('stand-in-git-instance'), {
      target: { value: gitlabTarget.instance },
    })
    fireEvent.click(screen.getByTestId('stand-in-git-search'))
    return { gitConnection, searchConnectionResources }
  }

  it('turns structured resource authorization into the existing native login card without starting OAuth', async () => {
    const { gitConnection } = renderGitlabDiscovery({
      status: 'auth_required',
      authTarget: gitlabTarget,
    })
    expect(await screen.findByTestId('stand-in-git-auth-dialog')).toBeInTheDocument()
    expect(gitConnection).toHaveBeenCalledExactlyOnceWith('mac', {
      channel: 'authTarget',
      instance: gitlabTarget.instance,
    })
    fireEvent.click(screen.getByTestId('gitlab-cli-login'))
    await waitFor(() =>
      expect(gitConnection).toHaveBeenCalledWith(
        'mac',
        expect.objectContaining({ channel: 'auth', authOperation: 'start', ...gitlabTarget })
      )
    )
  })

  it.each([
    { status: 'auth_required' },
    {
      status: 'auth_required',
      authTarget: { ...gitlabTarget, instance: 'https://different.company.example' },
    },
    { status: 'error', code: 'git_permission_denied' },
  ])(
    'does not open native authorization for missing, foreign, or non-auth availability: %j',
    async availability => {
      const { gitConnection } = renderGitlabDiscovery(availability)
      await screen.findByRole('alert')
      expect(screen.queryByTestId('stand-in-git-auth-dialog')).not.toBeInTheDocument()
      expect(gitConnection).not.toHaveBeenCalled()
    }
  )

  it('rejects a reported connector identity that does not match the native instance target', async () => {
    const { gitConnection } = renderGitlabDiscovery(
      { status: 'auth_required', authTarget: gitlabTarget },
      { ...gitlabTarget, connectorSlug: `wework-gitlab-cli-${'b'.repeat(64)}` }
    )
    await waitFor(() => expect(gitConnection).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('连接操作失败'))
    expect(screen.queryByTestId('stand-in-git-auth-dialog')).not.toBeInTheDocument()
  })

  it('stores personal scope as a draft without creating a cloud subscription', async () => {
    const onChange = vi.fn()
    const gitConnection = vi.fn(async () => ({ items: [] }))
    const searchConnectionResources = vi.fn(async () => ({
      items: [
        { id: 'personal', name: 'alice', kind: 'personal', profile, providerId: provider.id },
      ],
    }))
    render(
      <StandInGitConnections
        role={newStandInRole('mac', 'developer')}
        provider={provider}
        api={{ gitConnection, searchConnectionResources } as unknown as StandInExecutorApi}
        deviceId="mac"
        disabled={false}
        onChange={onChange}
      />
    )
    fireEvent.click(screen.getByTestId('stand-in-git-search'))
    fireEvent.click(await screen.findByTestId('stand-in-git-select-personal'))
    fireEvent.click(screen.getByTestId('stand-in-git-add'))
    await waitFor(() => expect(onChange).toHaveBeenCalledOnce())
    const source = onChange.mock.calls[0][0].connections[0]
    expect(source.profile).toBe(profile)
    expect(source.transport).toBe('cli')
    expect(source.policy).toEqual({ automatic: true, askBeforeAct: true, immediate: true })
    expect(gitConnection).not.toHaveBeenCalled()
  })

  it('stages a repository without cloud mutation until the profile is saved', async () => {
    const onChange = vi.fn()
    const gitConnection = vi.fn(async () => ({ items: [] }))
    const searchConnectionResources = vi.fn(async () => ({
      items: [{ id: '42', name: 'org/repo', kind: 'repository', profile, providerId: provider.id }],
    }))
    render(
      <StandInGitConnections
        role={newStandInRole('mac', 'developer')}
        provider={provider}
        api={{ gitConnection, searchConnectionResources } as unknown as StandInExecutorApi}
        deviceId="mac"
        disabled={false}
        onChange={onChange}
      />
    )
    fireEvent.change(screen.getByTestId('stand-in-git-kind'), { target: { value: 'repository' } })
    fireEvent.click(screen.getByTestId('stand-in-git-search'))
    fireEvent.click(await screen.findByTestId('stand-in-git-select-42'))
    fireEvent.click(screen.getByTestId('stand-in-git-add'))
    await waitFor(() => expect(onChange).toHaveBeenCalledOnce())
    expect(onChange.mock.calls[0][0].connections[0]).toMatchObject({
      id: '42',
      kind: 'repository',
      transport: 'cli',
    })
    expect(onChange.mock.calls[0][0].connections[0].subscriptionId).toBeUndefined()
    expect(gitConnection.mock.calls.every(([, input]) => input.operation === 'list')).toBe(true)
    expect(screen.queryByTestId('stand-in-git-webhook-setup')).not.toBeInTheDocument()
  })
  it.each(['github', 'gitlab'])(
    'offers business scopes without cloud controls for %s',
    platform => {
      const gitConnection = vi.fn()
      render(
        <StandInGitConnections
          role={newStandInRole('mac', 'developer')}
          provider={{ ...provider, id: '@wegent/dsh-connection-git/' + platform }}
          api={{ gitConnection } as unknown as StandInExecutorApi}
          deviceId="mac"
          disabled={false}
          onChange={vi.fn()}
        />
      )
      expect(screen.getByRole('option', { name: '个人全部事件' })).toBeInTheDocument()
      expect(screen.getByRole('option', { name: '只关注某个仓库' })).toBeInTheDocument()
      fireEvent.change(screen.getByTestId('stand-in-git-kind'), { target: { value: 'repository' } })
      expect(screen.getByLabelText('搜索仓库')).toHaveAttribute(
        'placeholder',
        '仓库名称或 owner/repo'
      )
      expect(screen.queryByText(/Webhook|轮询|自动分析和本地修改/)).not.toBeInTheDocument()
      expect(gitConnection).not.toHaveBeenCalled()
    }
  )
  it('clears an invalid instance error when the address is corrected without reading an account', async () => {
    const gitConnection = vi.fn()
    const searchConnectionResources = vi.fn()
    render(
      <StandInGitConnections
        role={newStandInRole('mac', 'developer')}
        provider={{ ...provider, id: '@wegent/dsh-connection-git/gitlab' }}
        api={{ gitConnection, searchConnectionResources } as unknown as StandInExecutorApi}
        deviceId="mac"
        disabled={false}
        onChange={vi.fn()}
      />
    )
    fireEvent.change(screen.getByTestId('stand-in-git-instance'), {
      target: { value: 'http://invalid' },
    })
    fireEvent.click(screen.getByTestId('stand-in-git-search'))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    fireEvent.change(screen.getByTestId('stand-in-git-instance'), {
      target: { value: 'https://gitlab.com' },
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(searchConnectionResources).not.toHaveBeenCalled()
    expect(gitConnection).not.toHaveBeenCalled()
  })
  it('clears old repository cursors when a GitLab instance or query changes', async () => {
    const gl = { ...provider, id: '@wegent/dsh-connection-git/gitlab' }
    const searchConnectionResources = vi.fn(async () => ({
      items: [],
      hasMore: true,
      nextCursor: '2',
    }))
    render(
      <StandInGitConnections
        role={newStandInRole('mac', 'developer')}
        provider={gl}
        api={
          {
            gitConnection: async () => ({ items: [] }),
            searchConnectionResources,
          } as unknown as StandInExecutorApi
        }
        deviceId="mac"
        disabled={false}
        onChange={vi.fn()}
      />
    )
    fireEvent.change(screen.getByTestId('stand-in-git-kind'), { target: { value: 'repository' } })
    fireEvent.click(screen.getByTestId('stand-in-git-search'))
    await screen.findByTestId('stand-in-git-more')
    fireEvent.change(screen.getByTestId('stand-in-git-instance'), {
      target: { value: 'https://gitlab.example' },
    })
    expect(screen.queryByTestId('stand-in-git-more')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('stand-in-git-search'))
    await screen.findByTestId('stand-in-git-more')
    expect(searchConnectionResources.mock.calls.at(-1)?.[3]).toContain('https://gitlab.example')
    expect(searchConnectionResources.mock.calls.at(-1)?.[4]).toBeUndefined()
    fireEvent.change(screen.getByTestId('stand-in-git-query'), { target: { value: 'new-query' } })
    expect(screen.queryByTestId('stand-in-git-more')).not.toBeInTheDocument()
  })
  it('rejects unsafe instance addresses before asking the execution device to read an account', async () => {
    const searchConnectionResources = vi.fn()
    render(
      <StandInGitConnections
        role={newStandInRole('mac', 'developer')}
        provider={{ ...provider, id: '@wegent/dsh-connection-git/gitlab' }}
        api={
          {
            gitConnection: async () => ({ items: [] }),
            searchConnectionResources,
          } as unknown as StandInExecutorApi
        }
        deviceId="mac"
        disabled={false}
        onChange={vi.fn()}
      />
    )
    fireEvent.change(screen.getByTestId('stand-in-git-instance'), {
      target: { value: 'http://gitlab.example' },
    })
    fireEvent.click(screen.getByTestId('stand-in-git-search'))
    expect(await screen.findByRole('alert')).toHaveTextContent('HTTPS')
    expect(searchConnectionResources).not.toHaveBeenCalled()
  })
})
