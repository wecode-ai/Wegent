import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { DesktopAppSwitcher } from './DesktopAppSwitcher'

const experimentalFeatures = vi.hoisted(() => ({ enabled: false }))

vi.mock('@/features/experimental-features/useExperimentalFeaturesEnabled', () => ({
  useExperimentalFeaturesEnabled: () => experimentalFeatures.enabled,
}))

describe('DesktopAppSwitcher', () => {
  afterEach(() => {
    vi.useRealTimers()
    experimentalFeatures.enabled = false
    window.history.pushState({}, '', '/')
  })

  test('keeps Kanban navigable while disconnected', () => {
    vi.useFakeTimers()
    experimentalFeatures.enabled = true
    const onNavigate = vi.fn()
    render(<DesktopAppSwitcher activeApp="wework" onNavigate={onNavigate} />)

    fireEvent.click(screen.getByTestId('chrome-tab-wework'))
    expect(screen.getByTestId('app-switcher-option-wework').parentElement).toHaveClass('pl-2')
    expect(screen.getByTestId('app-switcher-option-wework')).toHaveTextContent(
      '任务使用 AI 解决具体问题'
    )
    const todoOption = screen.getByTestId('app-switcher-option-todo')
    expect(todoOption).toBeEnabled()
    expect(screen.queryByTestId('app-switcher-unavailable-todo')).not.toBeInTheDocument()
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

    fireEvent.click(todoOption)
    act(() => vi.advanceTimersByTime(260))
    expect(onNavigate).toHaveBeenCalledWith('todo')
  })
})
