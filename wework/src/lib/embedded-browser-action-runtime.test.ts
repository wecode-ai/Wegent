import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

const actionScript = readFileSync(
  join(process.cwd(), 'src-tauri/src/embedded_browser_action.js'),
  'utf8'
)

function runAction(input: Record<string, unknown>) {
  document.elementFromPoint = ((x: number, y: number) => {
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
  element.getBoundingClientRect = () =>
    ({
      x: rect.x,
      y: rect.y,
      left: rect.x,
      top: rect.y,
      right: rect.x + rect.width,
      bottom: rect.y + rect.height,
      width: rect.width,
      height: rect.height,
      toJSON: () => ({}),
    }) as DOMRect
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
})
