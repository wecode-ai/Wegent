import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

const inspectScript = readFileSync(
  join(process.cwd(), 'electron/src/host/browser-runtime/embedded_browser_inspect.js'),
  'utf8'
)

function runInspect(options: Record<string, unknown> = {}) {
  const script = inspectScript.replace('__WEWORK_INSPECT_OPTIONS__', JSON.stringify(options))
  return new Function('window', `with (window) { return ${script.replace(/^;/, '')} }`)(window)
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

describe('embedded browser inspect runtime', () => {
  test('maps nested iframe elements into top-level coordinates', () => {
    document.body.innerHTML = ''
    const frame = document.createElement('iframe')
    document.body.append(frame)
    const childDocument = frame.contentDocument!
    const button = childDocument.createElement('button')
    button.textContent = '目标按钮：点击加一'
    childDocument.body.append(button)
    Object.defineProperties(frame, {
      offsetWidth: { configurable: true, value: 648 },
      offsetHeight: { configurable: true, value: 448 },
      clientLeft: { configurable: true, value: 4 },
      clientTop: { configurable: true, value: 4 },
      clientWidth: { configurable: true, value: 640 },
      clientHeight: { configurable: true, value: 440 },
    })
    frame.getBoundingClientRect = () => rectValue(100, 200, 324, 224)
    button.getBoundingClientRect = () => rectValue(110, 92, 100, 40)
    childDocument.elementFromPoint = (() => button) as typeof childDocument.elementFromPoint
    document.elementFromPoint = (() => frame) as typeof document.elementFromPoint

    const result = runInspect()
    const target = result.nodes.find((node: { name: string }) => node.name === '目标按钮：点击加一')

    expect(target).toMatchObject({
      actionable: true,
      frameId: 'frame-1',
      rect: { x: 157, y: 248, width: 50, height: 20 },
    })
    const resolved = window.__WEWORK_BROWSER_AGENT__.resolveInspectElement({
      inspectId: result.inspectId,
      index: target.index,
    })
    expect(resolved.viewportRect).toEqual({ x: 157, y: 248, width: 50, height: 20 })
  })
})
