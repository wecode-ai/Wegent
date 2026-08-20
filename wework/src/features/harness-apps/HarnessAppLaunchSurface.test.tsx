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
  test('shows animated, app-specific launch stages', () => {
    const { rerender } = render(<HarnessAppLaunchSurface launch={launch()} />)

    expect(
      screen.getByText('正在准备 日报助手 的运行环境，首次启动时会自动下载…')
    ).toBeInTheDocument()
    expect(screen.getByTestId('harness-app-animation-preparing-runtime')).toBeInTheDocument()

    rerender(<HarnessAppLaunchSurface launch={launch({ phase: 'loadingApp' })} />)
    expect(screen.getByText('正在加载 日报助手…')).toBeInTheDocument()
    expect(screen.getByTestId('harness-app-animation-loading-app')).toBeInTheDocument()

    rerender(<HarnessAppLaunchSurface launch={launch({ phase: 'startingApp' })} />)
    expect(screen.getByText('正在启动 日报助手…')).toBeInTheDocument()
    expect(screen.getByTestId('harness-app-animation-starting-app')).toBeInTheDocument()
  })

  test('keeps retry in the same app surface after startup fails', () => {
    const retry = vi.fn()
    render(
      <HarnessAppLaunchSurface launch={launch({ status: 'failed', error: '启动失败', retry })} />
    )

    fireEvent.click(screen.getByTestId('harness-app-launch-retry-app-1'))
    expect(retry).toHaveBeenCalledOnce()
  })
})
