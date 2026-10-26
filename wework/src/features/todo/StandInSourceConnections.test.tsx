import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { newStandInRole } from '@/api/personalStandIn'
import type { StandInExecutorApi } from '@/api/standIn'
import '@/i18n'
import { StandInSourceConnections } from './StandInSourceConnections'

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
