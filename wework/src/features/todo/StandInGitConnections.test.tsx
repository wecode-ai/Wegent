import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useRef, useState } from 'react'
import { expect, it, vi } from 'vitest'
import { newStandInPrimaryRole, type StandInSourceConnection } from '@/api/personalStandIn'
import type { ConnectionProviderDescriptor, StandInExecutorApi } from '@/api/standIn'
import { ConnectionScopeNavigation } from './connectionScopeNavigation'
import { GIT_CONNECTION_PREFIX, StandInGitConnections } from './StandInGitConnections'

it.each([
  ['github', 'GitHub'],
  ['gitlab', 'GitLab'],
])(
  'keeps the authenticated %s repository scope editable until the outer save',
  async (id, name) => {
    const provider: ConnectionProviderDescriptor = {
      id: GIT_CONNECTION_PREFIX + id,
      displayName: name,
      resourceKinds: ['personal', 'repository'],
      dependencies: [],
      availability: { status: 'ready' },
    }
    const account = {
      providerId: provider.id,
      profile: JSON.stringify([`https://${id}.com`, '7']),
      id: 'personal',
      kind: 'personal',
      name: 'Authenticated account',
    }
    const repository = { ...account, kind: 'repository', id: '42', name: 'team/repository' }
    const existing: StandInSourceConnection = {
      ...repository,
      id: '12',
      name: 'team/existing',
      policy: { automatic: true, askBeforeAct: true, immediate: true },
    }
    const otherAccount = {
      ...repository,
      id: '13',
      profile: JSON.stringify([`https://${id}.com`, '8']),
    }
    const search = vi
      .fn<StandInExecutorApi['searchConnectionResources']>()
      .mockResolvedValueOnce({ items: [account] })
      .mockResolvedValueOnce({ items: [repository, otherAccount] })
    const api = { searchConnectionResources: search } as unknown as StandInExecutorApi
    const saved = [existing]
    let draft = { ...newStandInPrimaryRole('local'), connections: saved }

    function Editor() {
      const [role, setRole] = useState(draft)
      const [title, setTitle] = useState<string | null>(null)
      const back = useRef<(() => void) | null>(null)
      return (
        <ConnectionScopeNavigation value={{ list: back, setTitle }}>
          <h2>{title ?? name}</h2>
          <button type="button" onClick={() => back.current?.()}>
            Back
          </button>
          <StandInGitConnections
            role={role}
            savedConnections={saved}
            provider={provider}
            api={api}
            deviceId="local"
            disabled={false}
            onChange={next => {
              draft = { ...next, connections: next.connections ?? [] }
              setRole(draft)
            }}
          />
        </ConnectionScopeNavigation>
      )
    }

    const user = userEvent.setup()
    render(<Editor />)
    await user.click(await screen.findByTestId('stand-in-git-add-scope'))
    expect(screen.getByRole('heading', { level: 2 })).not.toHaveTextContent(name)
    expect(screen.queryByTestId('stand-in-git-query')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('stand-in-git-kind-personal'))
    expect(draft.connections).toEqual([existing, expect.objectContaining(account)])
    expect(screen.queryByTestId('stand-in-git-personal-personal')).not.toBeInTheDocument()
    expect(screen.getByTestId('stand-in-processing-settings-toggle')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Back' }))
    await user.click(screen.getByTestId('stand-in-git-open-scope-personal-personal-remove'))
    expect(draft.connections).toEqual([existing])
    await user.click(screen.getByTestId('stand-in-git-add-scope'))
    await user.click(screen.getByTestId('stand-in-git-kind-repository'))
    await user.type(screen.getByTestId('stand-in-git-query'), 'repository')
    await user.click(screen.getByTestId('stand-in-git-search'))
    await user.click(await screen.findByTestId('stand-in-git-select-42'))
    expect(screen.queryByTestId('stand-in-git-select-13')).not.toBeInTheDocument()
    expect(draft.connections).toEqual([existing, expect.objectContaining(repository)])

    const back = screen.getByRole('button', { name: 'Back' })
    await user.click(back)
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(name)
    await user.click(screen.getByTestId('stand-in-git-open-scope-repository-42'))
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(repository.name)
    const disclosure = screen.getByTestId('stand-in-processing-settings-toggle')
    const summary = disclosure.textContent
    await user.click(disclosure)
    const selectedMode = screen.getByTestId('stand-in-git-policy-42').textContent!
    expect(summary).toContain(selectedMode)
    expect(disclosure.textContent).not.toContain(selectedMode)
    expect(screen.queryByTestId('stand-in-git-policy-12')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('stand-in-git-policy-42'))
    await user.click(await screen.findByTestId('stand-in-git-policy-42-manual'))
    await waitFor(() => expect(draft.connections[1].policy.automatic).toBe(false))
    await user.click(back)
    await user.click(screen.getByTestId('stand-in-git-open-scope-repository-42-remove'))
    expect(screen.queryByTestId('stand-in-git-open-scope-repository-42')).not.toBeInTheDocument()
    expect(draft.connections).toEqual([existing])
    expect(saved[0].policy).toEqual({ automatic: true, askBeforeAct: true, immediate: true })

    if (id === 'gitlab') {
      const instance = 'https://gitlab.example.test'
      const accountOnInstance = {
        ...account,
        profile: JSON.stringify([instance, '7']),
        name: 'Second GitLab instance',
      }
      search.mockResolvedValueOnce({ items: [accountOnInstance] })
      await user.click(screen.getByTestId('stand-in-git-open-scope-repository-12'))
      const instanceInput = screen.getByTestId('stand-in-git-instance')
      await user.clear(instanceInput)
      await user.type(instanceInput, instance)
      await user.tab()
      expect(await screen.findByText(accountOnInstance.name)).toBeInTheDocument()
      expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(name)
      expect(screen.getByTestId('stand-in-git-add-scope')).toBeEnabled()
      expect(draft.connections).toEqual([existing])

      search.mockResolvedValueOnce({ items: [account] })
      await user.clear(instanceInput)
      await user.type(instanceInput, 'https://gitlab.com')
      await user.tab()
      expect(await screen.findByTestId('stand-in-git-open-scope-repository-12')).toBeEnabled()
    }

    search.mockResolvedValueOnce({ items: [], availability: { status: 'auth_required' } })
    await user.click(screen.getByTestId('stand-in-git-add-scope'))
    await user.click(screen.getByTestId('stand-in-git-kind-repository'))
    await user.type(screen.getByTestId('stand-in-git-query'), 'repository')
    await user.click(screen.getByTestId('stand-in-git-search'))
    expect(await screen.findByTestId('stand-in-git-login')).toBeEnabled()
    expect(screen.getByTestId('stand-in-git-scope-requires-account')).toBeVisible()
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(name)
    expect(screen.getByTestId('stand-in-git-remove-12')).toBeEnabled()
    expect(draft.connections).toEqual([existing])
  }
)
