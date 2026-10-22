import { fireEvent, render, screen } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import i18n from '@/i18n'
import { WorkbenchErrorBoundary } from './WorkbenchErrorBoundary'
import { WorkbenchErrorPage } from './WorkbenchErrorPage'

function BrokenRender(): never {
  throw new Error('Render failed')
}

function BrokenEffect() {
  useEffect(() => {
    throw new Error('Effect failed')
  }, [])
  return <p>Loading</p>
}

function InteractiveCrash() {
  const [crashed, setCrashed] = useState(false)
  return crashed ? <BrokenRender /> : <button onClick={() => setCrashed(true)}>Crash</button>
}

describe('Workbench error recovery', () => {
  afterEach(async () => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    await i18n.changeLanguage('zh-CN')
  })

  test('keeps the healthy application visible', () => {
    render(
      <WorkbenchErrorBoundary>
        <p>Workbench</p>
      </WorkbenchErrorBoundary>
    )
    expect(screen.getByText('Workbench')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  test.each([BrokenRender, BrokenEffect])('shows recovery for a component crash: %s', Broken => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const onError = vi.fn()
    render(
      <WorkbenchErrorBoundary onError={onError}>
        <Broken />
      </WorkbenchErrorBoundary>
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Wework 页面出现错误')
    expect(onError).toHaveBeenCalledWith(expect.any(Error))
    expect(log).toHaveBeenCalledWith(
      '[Wework] Desktop frontend crashed:',
      expect.any(Error),
      expect.any(String)
    )
  })

  test('recovers from an update crash and reloads only when requested', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const reload = vi.fn()
    vi.stubGlobal(
      'window',
      new Proxy(window, {
        get(target, key) {
          return key === 'location' ? { reload } : Reflect.get(target, key)
        },
      })
    )
    render(
      <WorkbenchErrorBoundary>
        <InteractiveCrash />
      </WorkbenchErrorBoundary>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Crash' }))
    expect(screen.getByRole('alert')).toHaveTextContent('尚未保存的内容可能会丢失')
    expect(reload).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '刷新页面' }))
    expect(reload).toHaveBeenCalledOnce()
  })

  test('localizes startup recovery and preserves existing selectors', async () => {
    await i18n.changeLanguage('en')
    render(<WorkbenchErrorPage kind="startup" />)
    expect(screen.getByTestId('workbench-startup-error')).toHaveTextContent(
      'Wework could not start'
    )
    expect(screen.getByTestId('workbench-startup-retry')).toHaveAccessibleName('Refresh page')
  })
})
