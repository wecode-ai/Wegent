import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ConnectionRulesApi } from '@wegent/collaboration/automation'
import type { SharedWorkspaceApi } from '@wegent/collaboration'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { connectionRuleOwnerScope, type ConnectionRuleBinding } from '@/api/standIn'
import { useConnectionAutomationHost } from './useConnectionAutomationHost'

const connection = vi.hoisted(() => ({
  current: { apiBaseUrl: 'https://backend/api', serviceKey: 'backend', user: { id: 7 } },
}))
vi.mock('@/features/cloud-connection/useCloudConnection', () => ({
  useOptionalCloudConnection: () => connection.current,
}))

describe('source rule identity', () => {
  it('uses the actual cloud account for both RPC and private UI scope', () => {
    const list = vi.fn().mockResolvedValue([])
    const factory = vi.fn(
      (userId: number, binding: ConnectionRuleBinding) =>
        ({
          ownerScope: connectionRuleOwnerScope(userId, binding),
          list: () => list(userId),
        }) as unknown as ConnectionRulesApi
    )
    const services = { standInApi: { connectionRules: factory } } as unknown as WorkbenchServices
    const projectApi = {} as SharedWorkspaceApi
    const view = renderHook(() => useConnectionAutomationHost(services, 0, projectApi))
    const first = view.result.current!.api.ownerScope
    void view.result.current!.api.list()
    expect(list).toHaveBeenLastCalledWith(7)
    connection.current = { ...connection.current, user: { id: 8 } }
    view.rerender()
    expect(view.result.current!.api.ownerScope).not.toBe(first)
    void view.result.current!.api.list()
    expect(list).toHaveBeenLastCalledWith(8)
    const next = view.result.current!.api.ownerScope
    connection.current = { ...connection.current, user: { id: 8 } }
    view.rerender()
    expect(view.result.current!.api.ownerScope).toBe(next)
    connection.current = { ...connection.current, serviceKey: 'fallback:https://backend/api' }
    view.rerender()
    void view.result.current!.api.list()
    expect(list).toHaveBeenLastCalledWith(0)
  })
})
