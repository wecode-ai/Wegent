import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  CloudConnectionContext,
  type CloudConnectionContextValue,
} from '@/features/cloud-connection/CloudConnectionContext'
import { DesktopAppSwitcher } from './DesktopAppSwitcher'

const experimentalFeatures = vi.hoisted(() => ({ enabled: false }))

vi.mock('@/features/experimental-features/useExperimentalFeaturesEnabled', () => ({
  useExperimentalFeaturesEnabled: () => experimentalFeatures.enabled,
}))

const connectedCloud: CloudConnectionContextValue = {
  status: 'connected',
  backendUrl: 'https://backend.example.com',
  apiBaseUrl: 'https://backend.example.com/api',
  socketBaseUrl: 'https://backend.example.com',
  socketPath: '/socket.io',
  token: 'token',
  tokenExpiresAt: null,
  user: { id: 1, user_name: 'alice', email: 'alice@example.com' },
  connectedAt: '2026-07-18T00:00:00.000Z',
  error: null,
  isConnected: true,
  serviceKey: 'cloud:test',
  connectWithAuthorization: vi.fn(),
  refreshUser: vi.fn(),
  disconnect: vi.fn(),
}

describe('DesktopAppSwitcher', () => {
  afterEach(() => {
    vi.useRealTimers()
    experimentalFeatures.enabled = false
    window.history.pushState({}, '', '/')
  })

  test('renders 任务 as a compact product menu with a divider', () => {
    render(<DesktopAppSwitcher activeApp="wework" onNavigate={vi.fn()} />)

    expect(screen.getByTestId('desktop-app-switcher')).toHaveClass('pl-1', 'before:bg-border')
    expect(screen.getByTestId('desktop-app-switcher')).toHaveTextContent('任务')
    expect(screen.getByTestId('chrome-tab-wework')).toHaveTextContent('任务')
    expect(screen.getByTestId('chrome-tab-wework')).toHaveAttribute('aria-haspopup', 'menu')
  })

  test('shows Agent as unavailable while disconnected and hides Kanban', () => {
    const onNavigate = vi.fn()
    render(<DesktopAppSwitcher activeApp="wework" onNavigate={onNavigate} />)

    fireEvent.click(screen.getByTestId('chrome-tab-wework'))
    expect(screen.getByTestId('app-switcher-option-wework').parentElement).toHaveClass('pl-2')
    expect(screen.getByTestId('app-switcher-option-wework')).toHaveTextContent(
      '任务使用 AI 解决具体问题'
    )
    expect(screen.queryByTestId('app-switcher-option-todo')).not.toBeInTheDocument()
    const wegentOption = screen.getByTestId('app-switcher-option-wegent')
    expect(wegentOption).not.toHaveClass('opacity-60')
    expect(within(wegentOption).getByText('智能体')).toBeInTheDocument()
    expect(within(wegentOption).getByText('构建并交付可嵌入业务的云端智能体')).toBeInTheDocument()
    const unavailableStatus = screen.getByTestId('app-switcher-unavailable-wegent')
    expect(unavailableStatus).toHaveAccessibleName('连接云端后可用')
    fireEvent.mouseEnter(unavailableStatus)
    expect(screen.getByRole('tooltip')).toHaveTextContent('连接云端后可用')
    fireEvent.mouseLeave(unavailableStatus)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    fireEvent.focus(unavailableStatus)
    expect(screen.getByRole('tooltip')).toHaveTextContent('连接云端后可用')
    expect(wegentOption).toBeDisabled()
    fireEvent.click(wegentOption)
    expect(onNavigate).not.toHaveBeenCalled()
  })

  test('shows Kanban when experimental features are enabled', () => {
    experimentalFeatures.enabled = true
    render(<DesktopAppSwitcher activeApp="wework" onNavigate={vi.fn()} />)

    fireEvent.click(screen.getByTestId('chrome-tab-wework'))
    expect(
      within(screen.getByTestId('desktop-app-switcher-menu'))
        .getAllByRole('menuitemradio')
        .map(option => option.textContent)
    ).toEqual([
      '任务使用 AI 解决具体问题',
      '看板用 AI 管理项目的规划、执行与反馈',
      '智能体构建并交付可嵌入业务的云端智能体',
    ])
    expect(screen.getByTestId('app-switcher-option-todo')).toHaveTextContent(
      '看板用 AI 管理项目的规划、执行与反馈'
    )
  })

  test('keeps the Task, Kanban, Agent order when Agent is active', () => {
    experimentalFeatures.enabled = true
    render(
      <CloudConnectionContext.Provider value={connectedCloud}>
        <DesktopAppSwitcher activeApp="wegent" onNavigate={vi.fn()} />
      </CloudConnectionContext.Provider>
    )

    fireEvent.click(screen.getByTestId('chrome-tab-wegent'))
    expect(
      within(screen.getByTestId('desktop-app-switcher-menu'))
        .getAllByRole('menuitemradio')
        .map(option => option.textContent)
    ).toEqual([
      '任务使用 AI 解决具体问题',
      '看板用 AI 管理项目的规划、执行与反馈',
      '智能体构建并交付可嵌入业务的云端智能体',
    ])
  })

  test('shows Agent after connecting and navigates to it', () => {
    vi.useFakeTimers()
    const onNavigate = vi.fn()
    render(
      <CloudConnectionContext.Provider value={connectedCloud}>
        <DesktopAppSwitcher activeApp="wework" onNavigate={onNavigate} />
      </CloudConnectionContext.Provider>
    )

    fireEvent.click(screen.getByTestId('chrome-tab-wework'))
    fireEvent.click(screen.getByTestId('app-switcher-option-wegent'))
    act(() => vi.advanceTimersByTime(260))
    expect(onNavigate).toHaveBeenCalledWith('wegent')
  })

  test('labels the TODO board as Kanban', () => {
    render(<DesktopAppSwitcher activeApp="todo" onNavigate={vi.fn()} />)

    expect(screen.getByTestId('desktop-app-switcher')).toHaveTextContent('看板')
  })

  test('opens settings from the switcher menu', () => {
    window.history.pushState({}, '', '/app/wegent')
    render(
      <CloudConnectionContext.Provider value={connectedCloud}>
        <DesktopAppSwitcher activeApp="wegent" onNavigate={vi.fn()} />
      </CloudConnectionContext.Provider>
    )

    fireEvent.click(screen.getByTestId('chrome-tab-wegent'))
    expect(screen.getByTestId('app-switcher-option-wegent')).toHaveTextContent(
      '智能体构建并交付可嵌入业务的云端智能体'
    )
    fireEvent.click(screen.getByTestId('app-switcher-settings'))
    expect(window.location.pathname).toBe('/settings')
  })
})
