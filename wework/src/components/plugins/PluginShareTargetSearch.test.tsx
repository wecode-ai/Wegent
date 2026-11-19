import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { PluginShareTargetSearch } from './PluginShareTargetSearch'
import type { PluginShareUserSearchItem } from '@/api/plugins'

const user = {
  id: 8,
  user_name: 'Current member',
  email: 'member@example.test',
} as PluginShareUserSearchItem

describe('Plugin share directory selection', () => {
  it('ignores stale results, retries a failed query, and selects one unique identity', async () => {
    let resolveOld!: (value: PluginShareUserSearchItem[]) => void
    const searchUsers = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            resolveOld = resolve
          })
      )
      .mockResolvedValueOnce([user, user])
      .mockRejectedValueOnce(new Error('Directory unavailable'))
      .mockResolvedValueOnce([user, user])
    const searchGroups = vi.fn().mockResolvedValue([])
    const onSelect = vi.fn()
    render(
      <PluginShareTargetSearch
        searchUsers={searchUsers}
        searchGroups={searchGroups}
        onSelect={onSelect}
      />
    )
    const input = await screen.findByTestId('plugin-share-search')
    fireEvent.change(input, { target: { value: 'old' } })
    await waitFor(() => expect(searchUsers).toHaveBeenCalledWith('old'))
    fireEvent.change(input, { target: { value: 'current' } })
    await screen.findByTestId('plugin-share-user-8')
    expect(screen.getAllByTestId('plugin-share-user-8')).toHaveLength(1)
    await act(async () => resolveOld([{ ...user, id: 4, user_name: 'Stale member' }]))
    expect(screen.queryByTestId('plugin-share-user-4')).toBeNull()
    fireEvent.change(input, { target: { value: 'retry' } })
    const retry = await screen.findByTestId('plugin-share-search-retry')
    expect(screen.getByRole('alert')).toBeVisible()
    fireEvent.click(retry)
    fireEvent.click(await screen.findByTestId('plugin-share-user-8'))
    expect(searchUsers).toHaveBeenLastCalledWith('retry')
    expect(searchGroups).toHaveBeenLastCalledWith('retry')
    expect(onSelect).toHaveBeenCalledExactlyOnceWith({
      entityType: 'user',
      entityId: '8',
      displayName: 'Current member',
    })
  })
})
