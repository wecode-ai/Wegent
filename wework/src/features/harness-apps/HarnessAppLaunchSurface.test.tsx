import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { HarnessAppLaunchSurface } from './HarnessAppLaunchSurface'
import type { HarnessAppLaunchState } from './harnessAppLaunchState'

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, options?: string | { name?: string; defaultValue?: string }) => {
      if (typeof options === 'string') return options
      return options?.defaultValue ?? key
    },
  }),
}))

function launch(overrides: Partial<HarnessAppLaunchState> = {}): HarnessAppLaunchState {
  return {
    installationId: 'app-1',
    title: '日报助手',
    status: 'starting',
    phase: 'preparingRuntime',
    error: null,
    retry: vi.fn(),
    ...overrides,
  }
}

describe('HarnessAppLaunchSurface', () => {
  test('keeps retry in the same app surface after startup fails', () => {
    const retry = vi.fn()
    render(
      <HarnessAppLaunchSurface launch={launch({ status: 'failed', error: '启动失败', retry })} />
    )

    fireEvent.click(screen.getByTestId('harness-app-launch-retry-app-1'))
    expect(retry).toHaveBeenCalledOnce()
  })
})
