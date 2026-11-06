import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { newStandInRole } from '@/api/personalStandIn'
import type { StandInExecutorApi } from '@/api/standIn'
import '@/i18n'
import { StandInSourceConnections } from './StandInSourceConnections'

it('preserves plugin collection configuration when selecting a discovered resource', async () => {
  const item = {
    providerId: 'fixture',
    id: 'resource',
    profile: 'account',
    kind: 'item',
    name: 'Resource',
    collectionKey: 'opaque-selected',
    configurationSummary: 'Selected items #1, #2',
    selection: { items: [1, 2] },
  }
  const onChange = vi.fn()
  const user = userEvent.setup()
  render(
    <StandInSourceConnections
      provider={{
        id: 'fixture',
        displayName: 'Provider',
        resourceKinds: ['item'],
        resourceLabels: { item: 'Item' },
        dependencies: [],
        availability: { status: 'ready' },
      }}
      role={newStandInRole('device', 'default')}
      api={
        {
          searchConnectionResources: vi.fn().mockResolvedValue({ items: [item] }),
        } as unknown as StandInExecutorApi
      }
      deviceId="device"
      localDeviceId="device"
      disabled={false}
      onChange={onChange}
    />
  )
  await user.type(screen.getByTestId('stand-in-connection-fixture-query'), 'resource')
  await user.click(screen.getByTestId('stand-in-connection-fixture-search'))
  await user.click(await screen.findByTestId('stand-in-connection-fixture-result-resource'))
  await user.click(screen.getByTestId('stand-in-connection-fixture-add-selected'))
  expect(onChange.mock.calls[0][0].connections[0]).toMatchObject(item)
})

it.each(['resolve', 'reject'] as const)(
  'ignores a stale search %s after the visible query changes',
  async outcome => {
    type Result = Awaited<ReturnType<StandInExecutorApi['searchConnectionResources']>>
    let resolve!: (value: Result) => void
    let reject!: (error: Error) => void
    const pending = new Promise<Result>((done, fail) => {
      resolve = done
      reject = fail
    })
    const searchConnectionResources = vi
      .fn()
      .mockReturnValueOnce(pending)
      .mockResolvedValue({
        items: [
          {
            providerId: '@wegent/dsh-connection-dingtalk/dingtalk',
            id: 'new',
            name: 'New group',
            kind: 'group',
            profile: 'corp:user',
          },
        ],
        hasMore: false,
      })
    const user = userEvent.setup()
    render(
      <StandInSourceConnections
        provider={{
          id: '@wegent/dsh-connection-dingtalk/dingtalk',
          displayName: '钉钉',
          resourceKinds: ['group', 'direct'],
          dependencies: [],
          availability: { status: 'ready' },
        }}
        role={newStandInRole('device', 'default')}
        api={{ searchConnectionResources } as unknown as StandInExecutorApi}
        deviceId="device"
        localDeviceId="device"
        disabled={false}
        onChange={vi.fn()}
      />
    )
    if (screen.queryByTestId('stand-in-dingtalk-add'))
      await user.click(screen.getByTestId('stand-in-dingtalk-add'))
    const input = screen.getByTestId('stand-in-dingtalk-query')
    await user.type(input, 'old')
    await user.click(screen.getByTestId('stand-in-dingtalk-search'))
    await user.clear(input)
    await user.type(input, 'new')
    await act(async () => {
      if (outcome === 'reject') reject(new Error('Old query failed'))
      else
        resolve({
          items: [
            {
              providerId: '@wegent/dsh-connection-dingtalk/dingtalk',
              id: 'old',
              name: 'Old group',
              kind: 'group',
              profile: 'corp:user',
            },
          ],
          hasMore: true,
          nextCursor: 'old-cursor',
        })
    })
    await waitFor(() => expect(screen.getByTestId('stand-in-dingtalk-search')).toBeEnabled())
    expect(screen.queryByTestId('stand-in-dingtalk-result-old')).not.toBeInTheDocument()
    expect(screen.queryByTestId('stand-in-dingtalk-search-more')).not.toBeInTheDocument()
    expect(screen.queryByText('Old query failed')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('stand-in-dingtalk-search'))
    expect(await screen.findByTestId('stand-in-dingtalk-result-new')).toHaveTextContent('New group')
    expect(searchConnectionResources).toHaveBeenLastCalledWith(
      'device',
      '@wegent/dsh-connection-dingtalk/dingtalk',
      'group',
      'new',
      undefined
    )
  }
)

vi.mock('@/components/plugins/LocalConnectorAuthDialog', () => ({
  LocalConnectorAuthDialog: ({
    target,
  }: {
    target: { pluginKey: string; connectorSlug: string }
  }) => (
    <div data-testid="source-auth-dialog">
      {target.pluginKey}:{target.connectorSlug}
    </div>
  ),
}))

it.each([
  { code: 'connector_auth_required', localDeviceId: 'device', canAuthorize: true },
  { code: 'connector_auth_required', localDeviceId: 'other-device', canAuthorize: false },
  { code: 'permission_denied', localDeviceId: 'device', canAuthorize: false },
])(
  'keeps authorization recovery separate from translated errors: $code / $localDeviceId',
  async ({ code, localDeviceId, canAuthorize }) => {
    const searchConnectionResources = vi
      .fn()
      .mockRejectedValue({ code, message: 'Authorize the account' })
    const user = userEvent.setup()
    render(
      <StandInSourceConnections
        provider={{
          id: 'example',
          displayName: 'Example',
          resourceKinds: ['group'],
          dependencies: [],
          availability: { status: 'ready' },
          authTarget: { pluginKey: 'example-plugin', connectorSlug: 'work-account' },
        }}
        role={newStandInRole('device', 'default')}
        api={{ searchConnectionResources } as unknown as StandInExecutorApi}
        deviceId="device"
        localDeviceId={localDeviceId}
        disabled={false}
        onChange={vi.fn()}
      />
    )
    if (screen.queryByTestId('stand-in-connection-example-add'))
      await user.click(screen.getByTestId('stand-in-connection-example-add'))
    await user.type(screen.getByTestId('stand-in-connection-example-query'), 'group')
    await user.click(screen.getByTestId('stand-in-connection-example-search'))
    expect(await screen.findByRole('alert')).not.toHaveTextContent('Authorize the account')
    if (canAuthorize) {
      await user.click(screen.getByTestId('stand-in-connection-example-connect'))
      expect(screen.getByTestId('source-auth-dialog')).toHaveTextContent(
        'example-plugin:work-account'
      )
    } else {
      expect(screen.queryByTestId('stand-in-connection-example-connect')).not.toBeInTheDocument()
    }
  }
)

it.each([
  { code: 'connector_auth_required', localDeviceId: 'device', canAuthorize: true },
  { code: 'connector_auth_required', localDeviceId: 'other-device', canAuthorize: false },
  { code: 'permission_denied', localDeviceId: 'device', canAuthorize: false },
])(
  'recovers an all-scope failure using its error code: $code / $localDeviceId',
  async ({ code, localDeviceId, canAuthorize }) => {
    const onChange = vi.fn()
    const searchConnectionResources = vi.fn().mockRejectedValue({ code, message: 'Private error' })
    render(
      <StandInSourceConnections
        provider={{
          id: 'example',
          displayName: 'Example',
          resourceKinds: ['group'],
          allResourceKinds: ['group'],
          dependencies: [],
          availability: { status: 'ready' },
          authTarget: { pluginKey: 'example-plugin', connectorSlug: 'work-account' },
        }}
        role={newStandInRole('device')}
        api={{ searchConnectionResources } as unknown as StandInExecutorApi}
        deviceId="device"
        localDeviceId={localDeviceId}
        disabled={false}
        onChange={onChange}
      />
    )
    const user = userEvent.setup()
    await user.click(screen.getByTestId('stand-in-connection-example-add-all'))
    expect(await screen.findByRole('alert')).not.toHaveTextContent('Private error')
    expect(onChange).not.toHaveBeenCalled()
    if (code === 'connector_auth_required')
      expect(screen.getByTestId('stand-in-connection-example-authorization')).toBeVisible()
    else
      expect(
        screen.queryByTestId('stand-in-connection-example-authorization')
      ).not.toBeInTheDocument()
    if (canAuthorize) {
      await user.click(screen.getByTestId('stand-in-connection-example-connect'))
      expect(screen.getByTestId('source-auth-dialog')).toHaveTextContent(
        'example-plugin:work-account'
      )
      expect(screen.queryByTestId('stand-in-connection-example-add-all')).not.toBeInTheDocument()
    } else {
      expect(screen.queryByTestId('stand-in-connection-example-connect')).not.toBeInTheDocument()
    }
  }
)

it('batches selected resources across searches and only updates the role when adding', async () => {
  const { useState } = await import('react')
  const onChange = vi.fn()
  const resource = (id: string) => ({
    id,
    profile: 'corp',
    kind: 'group',
    providerId: 'example',
    name: id,
  })
  const searchConnectionResources = vi
    .fn()
    .mockResolvedValueOnce({ items: [resource('one'), resource('two')] })
    .mockResolvedValueOnce({ items: [resource('three')] })
  function Fixture() {
    const [role, setRole] = useState(newStandInRole('device'))
    return (
      <StandInSourceConnections
        provider={{
          id: 'example',
          displayName: 'Example',
          resourceKinds: ['group'],
          availability: { status: 'ready' },
          dependencies: [],
        }}
        role={role}
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
  const user = userEvent.setup()
  render(<Fixture />)
  if (screen.queryByTestId('stand-in-connection-example-add'))
    await user.click(screen.getByTestId('stand-in-connection-example-add'))
  await user.type(screen.getByTestId('stand-in-connection-example-query'), 'first')
  await user.click(screen.getByTestId('stand-in-connection-example-search'))
  await user.click(await screen.findByTestId('stand-in-connection-example-select-results'))
  expect(onChange).not.toHaveBeenCalled()
  await user.clear(screen.getByTestId('stand-in-connection-example-query'))
  await user.type(screen.getByTestId('stand-in-connection-example-query'), 'second')
  await user.click(screen.getByTestId('stand-in-connection-example-search'))
  await user.click(await screen.findByTestId('stand-in-connection-example-result-three'))
  await user.click(screen.getByTestId('stand-in-connection-example-add-selected'))
  expect(onChange).toHaveBeenCalledTimes(1)
  expect(onChange.mock.calls[0][0].connections.map((row: { id: string }) => row.id)).toEqual([
    'one',
    'two',
    'three',
  ])
})

it.each(['group', 'direct'])(
  'connects a continuous all-%s scope without enumerating or widening other accounts',
  async kind => {
    const role = newStandInRole('device')
    const connection = (profile: string, resourceKind: string, id: string) => ({
      providerId: 'example',
      profile,
      kind: resourceKind,
      id,
      name: id,
      policy: { automatic: true, askBeforeAct: true },
    })
    role.connections = [
      connection('corp', kind, 'old'),
      connection('other-account', kind, 'keep'),
      connection('corp', kind === 'group' ? 'direct' : 'group', 'other-kind'),
    ]
    const onChange = vi.fn()
    const searchConnectionResources = vi.fn().mockResolvedValue({
      items: [{ providerId: 'example', profile: 'corp', kind, id: '*', scope: 'all', name: 'All' }],
    })
    const user = userEvent.setup()
    render(
      <StandInSourceConnections
        role={role}
        provider={{
          id: 'example',
          displayName: 'Example',
          resourceKinds: [kind],
          allResourceKinds: [kind],
          availability: { status: 'ready' },
          dependencies: [],
        }}
        api={{ searchConnectionResources } as unknown as StandInExecutorApi}
        deviceId="device"
        localDeviceId="device"
        disabled={false}
        onChange={onChange}
      />
    )
    if (screen.queryByTestId('stand-in-connection-example-add'))
      await user.click(screen.getByTestId('stand-in-connection-example-add'))
    await user.click(screen.getByTestId('stand-in-connection-example-scope-all'))
    expect(screen.queryByTestId('stand-in-connection-example-query')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('stand-in-connection-example-add-all'))
    expect(searchConnectionResources).toHaveBeenCalledExactlyOnceWith(
      'device',
      'example',
      kind,
      '',
      undefined,
      'all'
    )
    await waitFor(() => expect(onChange).toHaveBeenCalledOnce())
    expect(onChange.mock.calls[0][0].connections).toEqual([
      role.connections[1],
      role.connections[2],
      expect.objectContaining({
        id: '*',
        scope: 'all',
        kind,
        profile: 'corp',
        policy: { automatic: true, askBeforeAct: true, immediate: true },
      }),
    ])
  }
)

it('defaults to all supported resource kinds and only reveals search after filtering', async () => {
  const searchConnectionResources = vi.fn(async (_device, providerId, kind) => ({
    items: [{ providerId, kind, profile: 'corp', id: '*', scope: 'all', name: kind }],
  }))
  const onChange = vi.fn()
  render(
    <StandInSourceConnections
      role={newStandInRole('device')}
      provider={{
        id: 'example',
        displayName: 'Example',
        resourceKinds: ['group', 'direct'],
        allResourceKinds: ['group', 'direct'],
        availability: { status: 'ready' },
        dependencies: [],
      }}
      api={{ searchConnectionResources } as unknown as StandInExecutorApi}
      deviceId="device"
      localDeviceId="device"
      disabled={false}
      onChange={onChange}
    />
  )
  expect(screen.getByTestId('stand-in-connection-example-scope-all')).toBeChecked()
  expect(screen.queryByTestId('stand-in-connection-example-add')).not.toBeInTheDocument()
  expect(screen.queryByTestId('stand-in-connection-example-query')).not.toBeInTheDocument()
  const user = userEvent.setup()
  await user.click(screen.getByTestId('stand-in-connection-example-scope-selected'))
  expect(screen.getByTestId('stand-in-connection-example-query')).toBeVisible()
  await user.click(screen.getByTestId('stand-in-connection-example-scope-all'))
  await user.click(screen.getByTestId('stand-in-connection-example-add-all'))
  await waitFor(() => expect(onChange).toHaveBeenCalledOnce())
  expect(onChange.mock.calls[0][0].connections.map((row: { kind: string }) => row.kind)).toEqual([
    'group',
    'direct',
  ])
  expect(searchConnectionResources).toHaveBeenCalledTimes(2)
})

it('keeps all groups when selected contacts replace the all-contacts scope', async () => {
  const role = newStandInRole('device')
  const allGroups = {
    providerId: 'example',
    profile: 'corp',
    kind: 'group',
    id: '*',
    scope: 'all' as const,
    name: 'All groups',
    policy: { automatic: true, askBeforeAct: true },
  }
  role.connections = [allGroups, { ...allGroups, kind: 'direct', name: 'All contacts' }]
  const onChange = vi.fn()
  const user = userEvent.setup()
  render(
    <StandInSourceConnections
      role={role}
      provider={{
        id: 'example',
        displayName: 'Example',
        resourceKinds: ['direct'],
        allResourceKinds: ['group', 'direct'],
        availability: { status: 'ready' },
        dependencies: [],
      }}
      api={
        {
          searchConnectionResources: vi.fn().mockResolvedValue({
            items: [{ profile: 'corp', kind: 'direct', id: 'contact', name: 'Selected contact' }],
            hasMore: false,
          }),
        } as unknown as StandInExecutorApi
      }
      deviceId="device"
      localDeviceId="device"
      disabled={false}
      onChange={onChange}
    />
  )
  await user.click(screen.getByTestId('stand-in-connection-example-add'))
  await user.click(screen.getByTestId('stand-in-connection-example-scope-selected'))
  await user.type(screen.getByTestId('stand-in-connection-example-query'), 'contact')
  await user.click(screen.getByTestId('stand-in-connection-example-search'))
  await user.click(await screen.findByTestId('stand-in-connection-example-result-contact'))
  await user.click(screen.getByTestId('stand-in-connection-example-add-selected'))
  expect(onChange).toHaveBeenCalledOnce()
  expect(onChange.mock.calls[0][0].connections).toEqual([
    allGroups,
    expect.objectContaining({ id: 'contact', kind: 'direct', profile: 'corp' }),
  ])
})

it('retains removable scope when an expired authorization is detected during search', async () => {
  const role = {
    ...newStandInRole('device'),
    connections: [
      {
        providerId: 'example',
        id: 'saved',
        name: 'Saved group',
        profile: 'corp',
        kind: 'group',
        policy: { automatic: true, askBeforeAct: true },
      },
    ],
  }
  const onChange = vi.fn()
  const searchConnectionResources = vi.fn().mockRejectedValue({ code: 'connector_auth_required' })
  render(
    <StandInSourceConnections
      provider={{
        id: 'example',
        displayName: 'Example',
        resourceKinds: ['group'],
        dependencies: [],
        availability: { status: 'ready' },
        authTarget: { pluginKey: 'example-plugin', connectorSlug: 'work-account' },
      }}
      role={role}
      api={{ searchConnectionResources } as unknown as StandInExecutorApi}
      deviceId="device"
      localDeviceId="device"
      disabled={false}
      onChange={onChange}
    />
  )
  const user = userEvent.setup()
  await user.click(screen.getByTestId('stand-in-connection-example-add'))
  await user.type(screen.getByTestId('stand-in-connection-example-query'), 'Other')
  await user.click(screen.getByTestId('stand-in-connection-example-search'))
  expect(await screen.findByTestId('stand-in-connection-example-authorization')).toHaveTextContent(
    'Saved group'
  )
  await user.click(screen.getByTestId('stand-in-connection-example-remove-saved'))
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ connections: [] }))
})
