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
    expect(source.policy).toEqual({ automatic: true, askBeforeAct: true, immediate: true })
    expect(gitConnection.mock.calls.every(([, input]) => input.operation === 'list')).toBe(true)
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
    expect(onChange.mock.calls[0][0].connections[0]).toMatchObject({ id: '42', kind: 'repository' })
    expect(onChange.mock.calls[0][0].connections[0].subscriptionId).toBeUndefined()
    expect(gitConnection.mock.calls.every(([, input]) => input.operation === 'list')).toBe(true)
    expect(screen.queryByTestId('stand-in-git-webhook-setup')).not.toBeInTheDocument()
  })
  it('reveals saved webhook credentials on demand without adding them to the profile', async () => {
    const role = newStandInRole('mac', 'developer')
    role.connections = [
      {
        id: '42',
        name: 'org/repo',
        kind: 'repository',
        profile,
        providerId: provider.id,
        subscriptionId: 'receiver',
        generation: 'one',
        policy: { automatic: true, askBeforeAct: true },
      },
    ]
    const onChange = vi.fn()
    const gitConnection = vi.fn(async (_device, input) =>
      input.operation === 'setup'
        ? { callbackUrl: 'https://cloud/hooks/receiver', secret: 'synthetic-secret' }
        : { items: [] }
    )
    render(
      <StandInGitConnections
        role={role}
        provider={provider}
        api={{ gitConnection } as unknown as StandInExecutorApi}
        deviceId="mac"
        disabled={false}
        onChange={onChange}
      />
    )
    fireEvent.click(screen.getByTestId('stand-in-git-setup-42'))
    await screen.findByTestId('stand-in-git-webhook-setup')
    expect(screen.getByTestId('stand-in-git-secret')).toHaveAttribute('type', 'password')
    expect(JSON.stringify(role)).not.toContain('synthetic-secret')
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('stand-in-git-hide-secret'))
    expect(screen.queryByTestId('stand-in-git-secret')).not.toBeInTheDocument()
  })
  it('stages takeover without changing the previous device before save', async () => {
    const onChange = vi.fn()
    const gitConnection = vi.fn(async (_device, input) =>
      input.operation === 'takeover'
        ? { generation: 'new' }
        : {
            items: [
              {
                id: 'receiver',
                active: true,
                deviceId: 'old-computer',
                generation: 'old',
                source: {
                  provider: 'github',
                  profile,
                  repositoryId: '42',
                  repositoryPath: 'org/repo',
                },
              },
            ],
          }
    )
    render(
      <StandInGitConnections
        role={newStandInRole('cloud', 'developer')}
        provider={provider}
        api={{ gitConnection } as unknown as StandInExecutorApi}
        deviceId="cloud"
        disabled={false}
        onChange={onChange}
      />
    )
    fireEvent.click(await screen.findByTestId('stand-in-git-takeover-receiver'))
    await waitFor(() => expect(onChange).toHaveBeenCalledOnce())
    expect(gitConnection.mock.calls.every(([, input]) => input.operation === 'list')).toBe(true)
    expect(onChange.mock.calls[0][0].connections[0]).toMatchObject({
      subscriptionId: 'receiver',
      generation: 'old',
      pendingTakeover: true,
      resumePending: true,
      profile,
    })
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
