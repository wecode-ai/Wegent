import { afterEach, describe, expect, test, vi } from 'vitest'
import { animateSmartAppIntoTab } from './smartAppLaunchAnimation'

describe('animateSmartAppIntoTab', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  test('moves a labeled app token toward the workspace tab add control', async () => {
    const target = document.createElement('button')
    target.dataset.testid = 'workspace-tab-add'
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 640, y: 12, width: 32, height: 32 })
    )
    document.body.append(target)
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: false }))
    )
    let finishAnimation: (() => void) | undefined
    const animate = vi.fn(
      () =>
        ({
          finished: new Promise<void>(resolve => {
            finishAnimation = resolve
          }),
        }) as Animation
    )
    Object.defineProperty(HTMLElement.prototype, 'animate', {
      configurable: true,
      value: animate,
    })

    const animation = animateSmartAppIntoTab({
      origin: DOMRect.fromRect({ x: 320, y: 420, width: 72, height: 36 }),
      title: '运营文本分类',
    })

    expect(document.querySelector('[data-testid="smart-app-launch-token"]')).toHaveTextContent(
      '运营文本分类'
    )
    expect(animate).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          transform: expect.stringContaining('translate('),
        }),
      ]),
      expect.objectContaining({ duration: 460 })
    )

    finishAnimation?.()
    await animation
    expect(document.querySelector('[data-testid="smart-app-launch-token"]')).toBeNull()
  })

  test('skips launch motion when reduced motion is requested', async () => {
    const target = document.createElement('button')
    target.dataset.testid = 'workspace-tab-add'
    document.body.append(target)
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true }))
    )
    const animate = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'animate', {
      configurable: true,
      value: animate,
    })

    await animateSmartAppIntoTab({
      origin: DOMRect.fromRect({ x: 320, y: 420, width: 72, height: 36 }),
      title: '运营文本分类',
    })

    expect(animate).not.toHaveBeenCalled()
    expect(document.querySelector('[data-testid="smart-app-launch-token"]')).toBeNull()
  })

  test('does not block opening the app when WebKit leaves animation.finished pending', async () => {
    vi.useFakeTimers()
    const target = document.createElement('button')
    target.dataset.testid = 'workspace-tab-add'
    document.body.append(target)
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: false }))
    )
    Object.defineProperty(HTMLElement.prototype, 'animate', {
      configurable: true,
      value: () =>
        ({
          finished: new Promise<void>(() => undefined),
        }) as Animation,
    })

    const animation = animateSmartAppIntoTab({
      origin: DOMRect.fromRect({ x: 320, y: 420, width: 72, height: 36 }),
      title: '运营文本分类',
    })
    await vi.advanceTimersByTimeAsync(560)
    await animation

    expect(document.querySelector('[data-testid="smart-app-launch-token"]')).toBeNull()
  })
})
