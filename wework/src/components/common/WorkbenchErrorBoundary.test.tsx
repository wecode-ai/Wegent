import i18n from '@/i18n'
import { copyTextToClipboard } from '@/lib/clipboard'
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { useDOMEvent } from '@wegent/collaboration/dom-events'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { WorkbenchErrorBoundary } from './WorkbenchErrorBoundary'

vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: vi.fn() }))

function BrokenRender(): never {
  throw new Error('Render failed')
}

function BrokenEffect() {
  const [target] = useState(() => {
    const target = new EventTarget()
    vi.spyOn(target, 'addEventListener').mockImplementation(() => {
      throw new Error('Effect failed')
    })
    return target
  })
  useDOMEvent(target, 'fixture-native-event', () => undefined)
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

  test('copies the update crash details after a clipboard failure and reloads only when requested', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const copy = vi.mocked(copyTextToClipboard)
    copy.mockRejectedValueOnce(new Error('Clipboard unavailable')).mockResolvedValueOnce(undefined)
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
    const copyButton = screen.getByRole('button', { name: '复制调试信息' })
    fireEvent.click(copyButton)
    expect(await screen.findByText('复制失败，请重试。')).toBeVisible()
    fireEvent.click(copyButton)
    expect(await screen.findByText('已复制调试信息')).toBeVisible()
    expect(copy).toHaveBeenLastCalledWith(
      expect.stringMatching(/Render failed[\s\S]*at InteractiveCrash/)
    )
    expect(reload).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '刷新页面' }))
    expect(reload).toHaveBeenCalledOnce()
  })
})
