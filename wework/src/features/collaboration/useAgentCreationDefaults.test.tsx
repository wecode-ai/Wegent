import { renderHook } from '@testing-library/react'
import { expect, test, vi } from 'vitest'

import type { WorkbenchContextValue } from '@/features/workbench/workbenchContextTypes'
import { WorkbenchContext } from '@/features/workbench/useWorkbench'
import { useAgentCreationDefaults } from './useAgentCreationDefaults'

vi.mock('@/desktop/localExecutor', () => ({
  getKnownLocalExecutorDeviceId: () => 'current-executor',
}))

test('uses the personal default before the actual current executor and includes transport aliases', () => {
  const value = {
    state: {
      user: { preferences: { default_execution_target: 'preferred-app' } },
      devices: [{ device_id: 'preferred-app', socket_device_id: 'preferred-runner' }],
    },
  } as unknown as WorkbenchContextValue
  const { result } = renderHook(() => useAgentCreationDefaults(true), {
    wrapper: ({ children }) => (
      <WorkbenchContext.Provider value={value}>{children}</WorkbenchContext.Provider>
    ),
  })
  expect(result.current).toEqual({
    preferredDeviceIds: ['preferred-app', 'preferred-runner', 'current-executor'],
  })
})

test('does not enable defaults for existing agents', () => {
  const { result } = renderHook(() => useAgentCreationDefaults(false))
  expect(result.current).toBeUndefined()
})
