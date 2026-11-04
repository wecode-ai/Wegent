import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

const actionScript = readFileSync(
  join(process.cwd(), 'electron/src/host/browser-runtime/embedded_browser_action.js'),
  'utf8'
)

function runAction(
  input: Record<string, unknown>,
  elementFromPoint?: (x: number, y: number) => Element | null
) {
  document.elementFromPoint = ((x: number, y: number) => {
    if (elementFromPoint) return elementFromPoint(x, y)
    return (
      Array.from(document.querySelectorAll<HTMLElement>('[data-test-hit-target]')).find(element => {
        const rect = element.getBoundingClientRect()
        return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
      }) ?? document.body
    )
  }) as typeof document.elementFromPoint
  const script = actionScript.replace('__WEWORK_ACTION_INPUT__', JSON.stringify(input))
  const expression = script.replace(/^;/, '')
  return new Function('window', `with (window) { return ${expression} }`)(window)
}

function mockRect(
  element: HTMLElement,
  rect: { x: number; y: number; width: number; height: number }
) {
  element.dataset.testHitTarget = 'true'
  element.getBoundingClientRect = () => rectValue(rect.x, rect.y, rect.width, rect.height)
}

function rectValue(x: number, y: number, width: number, height: number) {
  return {
    x,
    y,
    left: x,
    top: y,
    right: x + width,
    bottom: y + height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect
}

function mockFrame(
  frame: HTMLIFrameElement,
  options: {
    rect: { x: number; y: number; width: number; height: number }
    layoutWidth: number
    layoutHeight: number
    clientLeft?: number
    clientTop?: number
    clientWidth: number
    clientHeight: number
  }
) {
  Object.defineProperties(frame, {
    offsetWidth: { configurable: true, value: options.layoutWidth },
    offsetHeight: { configurable: true, value: options.layoutHeight },
    clientLeft: { configurable: true, value: options.clientLeft ?? 0 },
    clientTop: { configurable: true, value: options.clientTop ?? 0 },
    clientWidth: { configurable: true, value: options.clientWidth },
    clientHeight: { configurable: true, value: options.clientHeight },
  })
  frame.getBoundingClientRect = () =>
    rectValue(options.rect.x, options.rect.y, options.rect.width, options.rect.height)
}

describe('embedded browser action runtime', () => {
  test('does not require high-risk approval for a search submit button', () => {
    document.body.innerHTML = `
      <form id="form" action="/s" role="search">
        <input id="kw" name="wd" />
        <input id="su" type="submit" value="百度一下" />
      </form>
      <output id="result">idle</output>
    `
    document.getElementById('form')?.addEventListener('submit', event => {
      event.preventDefault()
      document.getElementById('result')!.textContent = 'searched'
    })
    mockRect(document.getElementById('su') as HTMLElement, {
      x: 20,
      y: 20,
      width: 120,
      height: 32,
    })

    const result = runAction({ action: 'click', selector: '#su' })

    expect(result.ok).toBe(true)
    expect(result.error?.code).not.toBe('approval_required')
    expect(document.getElementById('result')).toHaveTextContent('searched')
  })

  test('fills the latest inspect target by index without an explicit inspect id', () => {
    document.body.innerHTML = `
      <input id="kw" name="wd" />
    `
    const input = document.getElementById('kw') as HTMLInputElement
    mockRect(input, {
      x: 20,
      y: 20,
      width: 320,
      height: 32,
    })
    window.__WEWORK_BROWSER_AGENT__ = {
      resolveInspectElement: ({ index }: { index?: number }) => ({
        ok: index === 0,
        element: input,
        ref: 'wk-mvp:latest:main:0:kw',
        inspectId: 'wk-inspect-latest',
        index: 0,
        frameId: 'main',
        role: 'textbox',
        name: '百度搜索',
        rect: { x: 20, y: 20, width: 320, height: 32 },
      }),
    }

    const result = runAction({ action: 'fill', index: 0, text: '微博' })

    expect(result.ok).toBe(true)
    expect(input.value).toBe('微博')
    expect(result.target.ref).toBe('wk-mvp:latest:main:0:kw')
  })

  test('still requires approval for destructive click targets', () => {
    document.body.innerHTML = `
      <button id="delete-record" type="button">Delete agent record</button>
    `
    mockRect(document.getElementById('delete-record') as HTMLElement, {
      x: 20,
      y: 20,
      width: 180,
      height: 32,
    })

    const result = runAction({ action: 'click', selector: '#delete-record' })

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('approval_required')
  })

  test('previews a click target without dispatching the click', () => {
    document.body.innerHTML = `
      <button id="run-agent" type="button">Run agent</button>
    `
    const button = document.getElementById('run-agent') as HTMLButtonElement
    mockRect(button, {
      x: 40,
      y: 30,
      width: 120,
      height: 40,
    })
    let clicked = false
    button.addEventListener('click', () => {
      clicked = true
    })

    const result = runAction({
      action: 'click',
      selector: '#run-agent',
      previewOnly: true,
    })

    expect(result.ok).toBe(true)
    expect(result.previewOnly).toBe(true)
    expect(result.target.rect).toEqual({
      x: 40,
      y: 30,
      width: 120,
      height: 40,
    })
    expect(clicked).toBe(false)
  })

  test('clicks an element in a scaled iframe using top-level viewport coordinates', () => {
    document.body.innerHTML = ''
    const frame = document.createElement('iframe')
    document.body.append(frame)
    const childDocument = frame.contentDocument!
    const button = childDocument.createElement('button')
    button.textContent = '目标按钮：点击加一'
    childDocument.body.append(button)
    let clicked = 0
    button.addEventListener('click', () => {
      clicked += 1
    })
    mockFrame(frame, {
      rect: { x: 100, y: 200, width: 324, height: 224 },
      layoutWidth: 648,
      layoutHeight: 448,
      clientLeft: 4,
      clientTop: 4,
      clientWidth: 640,
      clientHeight: 440,
    })
    button.getBoundingClientRect = () => rectValue(110, 92, 100, 40)
    childDocument.elementFromPoint = ((x: number, y: number) => {
      return x >= 110 && x <= 210 && y >= 92 && y <= 132 ? button : childDocument.body
    }) as typeof childDocument.elementFromPoint
    window.__WEWORK_BROWSER_AGENT__ = {
      resolveInspectElement: () => ({
        ok: true,
        element: button,
        ref: 'wk-mvp:inspect:frame-1:0:target',
        inspectId: 'wk-inspect-1',
        index: 0,
        frameId: 'frame-1',
        role: 'button',
        name: '目标按钮：点击加一',
        rect: { x: 110, y: 92, width: 100, height: 40 },
        viewportRect: { x: 157, y: 248, width: 50, height: 20 },
      }),
    }

    const result = runAction({ action: 'click', index: 0 }, (x, y) =>
      x >= 100 && x <= 424 && y >= 200 && y <= 424 ? frame : document.body
    )

    expect(result.ok).toBe(true)
    expect(result.target.rect).toEqual({ x: 157, y: 248, width: 50, height: 20 })
    expect(result.target.localRect).toEqual({ x: 110, y: 92, width: 100, height: 40 })
    expect(result.target.viewportRect).toEqual({ x: 157, y: 248, width: 50, height: 20 })
    expect(clicked).toBe(1)
  })

  test('coordinate clicks descend through nested iframes', () => {
    document.body.innerHTML = ''
    const outerFrame = document.createElement('iframe')
    document.body.append(outerFrame)
    const outerDocument = outerFrame.contentDocument!
    const innerFrame = outerDocument.createElement('iframe')
    outerDocument.body.append(innerFrame)
    const innerDocument = innerFrame.contentDocument!
    const button = innerDocument.createElement('button')
    button.textContent = '目标按钮：点击加一'
    innerDocument.body.append(button)
    let clicked = 0
    button.addEventListener('click', () => {
      clicked += 1
    })
    mockFrame(outerFrame, {
      rect: { x: 100, y: 100, width: 400, height: 300 },
      layoutWidth: 400,
      layoutHeight: 300,
      clientWidth: 400,
      clientHeight: 300,
    })
    mockFrame(innerFrame, {
      rect: { x: 50, y: 40, width: 200, height: 100 },
      layoutWidth: 200,
      layoutHeight: 100,
      clientWidth: 200,
      clientHeight: 100,
    })
    button.getBoundingClientRect = () => rectValue(10, 20, 100, 30)
    outerDocument.elementFromPoint = (() => innerFrame) as typeof outerDocument.elementFromPoint
    innerDocument.elementFromPoint = (() => button) as typeof innerDocument.elementFromPoint

    const result = runAction({ action: 'click', x: 200, y: 170 }, () => outerFrame)

    expect(result.ok, JSON.stringify(result.error)).toBe(true)
    expect(result.target.rect).toEqual({ x: 160, y: 160, width: 100, height: 30 })
    expect(result.target.viewportRect).toEqual({ x: 160, y: 160, width: 100, height: 30 })
    expect(clicked).toBe(1)
  })
})
