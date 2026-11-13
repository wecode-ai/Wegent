import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { newStandInRole, type StandInRole } from '@/api/personalStandIn'
import type { StandInExecutorApi } from '@/api/standIn'
import '@/i18n'
import { StandInSourceConnections } from './StandInSourceConnections'

const provider = {
  id: '@wegent/dsh-connection-dingtalk/dingtalk',
  displayName: 'DingTalk',
  resourceKinds: ['group', 'direct'],
  allResourceKinds: ['group', 'direct'],
  dependencies: [],
  availability: { status: 'ready' },
}

it.each(['group', 'direct'])(
  'edits and restores an account-bound %s blacklist without replacing all scope',
  async kind => {
    const source = {
      providerId: provider.id,
      profile: 'corp',
      kind,
      id: '*',
      scope: 'all' as const,
      name: 'All',
      policy: { automatic: true, askBeforeAct: true },
      excludedResources: [{ id: 'saved', name: 'Saved exclusion' }],
    }
    const other = { ...source, profile: 'other' }
    const onChange = vi.fn()
    const searchConnectionResources = vi.fn().mockResolvedValue({
      items: [
        { ...source, id: 'new', scope: undefined, name: 'New exclusion' },
        { ...source, id: 'saved', scope: undefined, name: 'Saved exclusion' },
        { ...other, id: 'foreign', scope: undefined },
      ],
    })
    function Fixture() {
      const [role, setRole] = useState<StandInRole>({
        ...newStandInRole('device'),
        connections: [source, other],
      })
      return (
        <StandInSourceConnections
          role={role}
          provider={provider}
          api={{ searchConnectionResources } as unknown as StandInExecutorApi}
          deviceId="device"
          localDeviceId="device"
          disabled={false}
          onChange={next => {
            onChange(next)
            setRole(next)
          }}
        />
      )
    }
    render(<Fixture />)
    const user = userEvent.setup()
    await user.click(screen.getByTestId(`stand-in-dingtalk-blacklist-add-${kind}-corp`))
    expect(screen.queryByTestId('stand-in-dingtalk-kind')).not.toBeInTheDocument()
    await user.type(screen.getByTestId('stand-in-dingtalk-query'), 'exclude')
    await user.click(screen.getByTestId('stand-in-dingtalk-search'))
    expect(await screen.findByTestId('stand-in-dingtalk-result-saved')).toBeDisabled()
    expect(screen.queryByTestId('stand-in-dingtalk-result-foreign')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('stand-in-dingtalk-result-new'))
    expect(onChange).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('stand-in-dingtalk-add-selected'))
    const saved = onChange.mock.calls[0][0]
    expect(saved.connections[0]).toEqual({
      ...source,
      excludedResources: [...source.excludedResources, { id: 'new', name: 'New exclusion' }],
    })
    expect(saved.connections[1]).toEqual(other)
    expect(source.excludedResources).toHaveLength(1)
    await user.click(screen.getByTestId(`stand-in-dingtalk-blacklist-remove-${kind}-corp-new`))
    expect(onChange.mock.calls[1][0].connections[0]).toEqual(source)
    await user.click(screen.getByTestId(`stand-in-dingtalk-blacklist-add-${kind}-corp`))
    await user.click(screen.getByTestId('stand-in-dingtalk-blacklist-cancel'))
    expect(onChange).toHaveBeenCalledTimes(2)
  }
)

function renderAllGroup({
  status = 'ready',
  search = vi.fn(),
}: { status?: string; search?: ReturnType<typeof vi.fn> } = {}) {
  const source = {
    providerId: provider.id,
    profile: 'corp',
    kind: 'group',
    id: '*',
    scope: 'all' as const,
    name: 'All groups',
    policy: { automatic: true, askBeforeAct: true },
    excludedResources: [{ id: 'saved', name: 'Saved exclusion' }],
  }
  const onChange = vi.fn()
  function Fixture() {
    const [role, setRole] = useState<StandInRole>({
      ...newStandInRole('device'),
      connections: [source],
    })
    return (
      <StandInSourceConnections
        role={role}
        provider={{ ...provider, availability: { status } }}
        api={{ searchConnectionResources: search } as unknown as StandInExecutorApi}
        deviceId="device"
        localDeviceId="device"
        disabled={false}
        onChange={next => {
          onChange(next)
          setRole(next)
        }}
      />
    )
  }
  render(<Fixture />)
  return { onChange }
}

it('closes the blacklist editor and ignores its pending search when its connection is removed', async () => {
  type Result = Awaited<ReturnType<StandInExecutorApi['searchConnectionResources']>>
  let resolve!: (value: Result) => void
  const search = vi.fn().mockReturnValue(
    new Promise<Result>(done => {
      resolve = done
    })
  )
  const { onChange } = renderAllGroup({ search })
  const user = userEvent.setup()
  await user.click(screen.getByTestId('stand-in-dingtalk-blacklist-add-group-corp'))
  await user.type(screen.getByTestId('stand-in-dingtalk-query'), 'pending')
  await user.click(screen.getByTestId('stand-in-dingtalk-search'))
  await user.click(screen.getByTestId('stand-in-dingtalk-remove-*'))
  expect(screen.queryByTestId('stand-in-dingtalk-blacklist-cancel')).not.toBeInTheDocument()
  expect(screen.getByTestId('stand-in-dingtalk-kind')).toBeInTheDocument()
  expect(onChange).toHaveBeenCalledOnce()
  expect(onChange.mock.calls[0][0].connections).toEqual([])
  const { act } = await import('@testing-library/react')
  await act(async () =>
    resolve({
      items: [
        {
          id: 'late',
          name: 'Late result',
          profile: 'corp',
          kind: 'group',
          providerId: provider.id,
        },
      ],
    })
  )
  expect(screen.queryByTestId('stand-in-dingtalk-result-late')).not.toBeInTheDocument()
  expect(onChange).toHaveBeenCalledOnce()
})

it.each(['provider', 'search'])(
  'disables blacklist search during %s authorization recovery while retaining removal',
  async origin => {
    renderAllGroup({
      status: origin === 'provider' ? 'auth_required' : 'ready',
      search: vi.fn().mockRejectedValue({ code: 'connector_auth_required' }),
    })
    const user = userEvent.setup()
    if (origin === 'search') {
      await user.click(screen.getByTestId('stand-in-dingtalk-blacklist-add-group-corp'))
      await user.type(screen.getByTestId('stand-in-dingtalk-query'), 'group')
      await user.click(screen.getByTestId('stand-in-dingtalk-search'))
    }
    expect(await screen.findByTestId('stand-in-dingtalk-authorization')).toBeInTheDocument()
    expect(screen.getByTestId('stand-in-dingtalk-blacklist-add-group-corp')).toBeDisabled()
    expect(screen.getByTestId('stand-in-dingtalk-blacklist-remove-group-corp-saved')).toBeEnabled()
  }
)
