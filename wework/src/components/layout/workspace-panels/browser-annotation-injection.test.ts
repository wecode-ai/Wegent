import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { browserAnnotationInjectionScript } from './browser-annotation/injection-script'

interface RuntimeApi {
  scope: { browserTabId: string; pageSessionId: string; url: string }
  getSnapshot: () => { revision: number; annotations: Array<{ comment: string; number: number }> }
  clear: () => { revision: number; annotations: Array<{ comment: string; number: number }> }
  suspend: () => unknown
  resume: () => unknown
  destroy: () => void
}

type AnnotationWindow = Window & { __WEWORK_BROWSER_ANNOTATION__?: RuntimeApi }

const annotationWindow = window as AnnotationWindow

function setElementRect(element: HTMLElement, x: number, y: number) {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    bottom: y + 40,
    height: 40,
    left: x,
    right: x + 120,
    top: y,
    width: 120,
    x,
    y,
    toJSON: () => ({}),
  })
}

function click(element: Element) {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

function openEditor(target: HTMLElement) {
  elementsFromPointTarget = target
  const blocker = document.querySelector<HTMLElement>('[data-wework-annotation="blocker"]')!
  blocker.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
  click(blocker)
  return document.querySelector<HTMLInputElement>('[data-wework-annotation="comment-input"]')
}

let elementsFromPointTarget: Element | null = null

function saveButton() {
  return (
    document.querySelector<HTMLButtonElement>('[data-wework-annotation="save"]') ||
    document.querySelector<HTMLButtonElement>('[data-wework-annotation="submit"]')
  )
}

describe('browser annotation injection', () => {
  beforeEach(() => {
    elementsFromPointTarget = null
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      writable: true,
      value: () => (elementsFromPointTarget ? [elementsFromPointTarget] : []),
    })
    document.body.innerHTML =
      '<main><button id="first-target">First target</button><button id="second-target">Second target</button></main>'
    setElementRect(document.querySelector('#first-target')!, 20, 30)
    setElementRect(document.querySelector('#second-target')!, 180, 90)
    window.eval(browserAnnotationInjectionScript({ browserTabId: 'test-browser' }))
  })

  afterEach(() => {
    annotationWindow.__WEWORK_BROWSER_ANNOTATION__?.destroy()
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  test('publishes a non-destructive revision snapshot', () => {
    const input = openEditor(document.querySelector('#first-target')!)
    input!.value = 'First comment'
    input!.dispatchEvent(new Event('input', { bubbles: true }))
    click(saveButton()!)

    const first = annotationWindow.__WEWORK_BROWSER_ANNOTATION__?.getSnapshot()
    const second = annotationWindow.__WEWORK_BROWSER_ANNOTATION__?.getSnapshot()
    expect(first).toEqual(second)
    expect(first).toMatchObject({
      revision: 1,
      annotations: [{ comment: 'First comment', number: 1 }],
    })
    expect(document.querySelectorAll('[data-wework-annotation="marker"]')).toHaveLength(1)
  })

  test('edits a published annotation without changing its number', () => {
    const input = openEditor(document.querySelector('#first-target')!)
    input!.value = 'First comment'
    input!.dispatchEvent(new Event('input', { bubbles: true }))
    click(saveButton()!)
    click(document.querySelector('[data-wework-annotation="marker"]')!)

    const editorInput = document.querySelector<HTMLInputElement>(
      '[data-wework-annotation="comment-input"]'
    )!
    editorInput.value = 'Edited comment'
    editorInput.dispatchEvent(new Event('input', { bubbles: true }))
    click(saveButton()!)

    expect(annotationWindow.__WEWORK_BROWSER_ANNOTATION__?.getSnapshot()).toMatchObject({
      revision: 2,
      annotations: [{ comment: 'Edited comment', number: 1 }],
    })
  })

  test('deletes one annotation without a confirmation dialog', () => {
    const input = openEditor(document.querySelector('#first-target')!)
    input!.value = 'First comment'
    input!.dispatchEvent(new Event('input', { bubbles: true }))
    click(saveButton()!)
    click(document.querySelector('[data-wework-annotation="marker"]')!)
    click(document.querySelector('[data-wework-annotation="delete"]')!)

    expect(document.querySelector('[data-wework-annotation="delete-confirmation"]')).toBeNull()
    expect(annotationWindow.__WEWORK_BROWSER_ANNOTATION__?.getSnapshot()).toMatchObject({
      revision: 2,
      annotations: [],
    })
  })

  test('suspends without losing annotations and resumes their boxes', () => {
    const input = openEditor(document.querySelector('#first-target')!)
    input!.value = 'First comment'
    input!.dispatchEvent(new Event('input', { bubbles: true }))
    click(saveButton()!)

    annotationWindow.__WEWORK_BROWSER_ANNOTATION__?.suspend()
    expect(document.querySelectorAll('[data-wework-annotation="marker"]')).toHaveLength(0)
    expect(annotationWindow.__WEWORK_BROWSER_ANNOTATION__?.getSnapshot().annotations).toHaveLength(
      1
    )

    annotationWindow.__WEWORK_BROWSER_ANNOTATION__?.resume()
    expect(document.querySelectorAll('[data-wework-annotation="marker"]')).toHaveLength(1)
  })

  test('clears annotations while keeping the runtime available', () => {
    const input = openEditor(document.querySelector('#first-target')!)
    input!.value = 'First comment'
    input!.dispatchEvent(new Event('input', { bubbles: true }))
    click(saveButton()!)

    const result = annotationWindow.__WEWORK_BROWSER_ANNOTATION__?.clear()
    expect(result).toMatchObject({ revision: 2, annotations: [] })
    expect(annotationWindow.__WEWORK_BROWSER_ANNOTATION__?.getSnapshot().annotations).toEqual([])
    expect(document.querySelector('[data-wework-annotation-layer]')).not.toBeNull()
  })

  test('restores the element baseline on suspend and clear, then replays saved adjustments', () => {
    const target = document.querySelector<HTMLElement>('#first-target')!
    target.style.color = 'blue'
    const input = openEditor(target)
    input!.value = 'Use a stronger color'
    input!.dispatchEvent(new Event('input', { bubbles: true }))
    click(document.querySelector('[data-wework-annotation="adjust-toggle"]')!)

    const color = document.querySelector<HTMLInputElement>(
      '[data-wework-annotation="adjustment-color"]'
    )!
    color.value = '#ff0000'
    color.dispatchEvent(new Event('input', { bubbles: true }))
    expect(target.style.color).toBe('rgb(255, 0, 0)')

    click(saveButton()!)
    annotationWindow.__WEWORK_BROWSER_ANNOTATION__?.suspend()
    expect(target.style.color).toBe('blue')

    annotationWindow.__WEWORK_BROWSER_ANNOTATION__?.resume()
    expect(target.style.color).toBe('rgb(255, 0, 0)')
    annotationWindow.__WEWORK_BROWSER_ANNOTATION__?.clear()
    expect(target.style.color).toBe('blue')
  })

  test('renders grouped adjustment rows with reset and unit after opening tweaks', () => {
    const target = document.querySelector<HTMLElement>('#first-target')!
    openEditor(target)
    click(document.querySelector('[data-wework-annotation="adjust-toggle"]')!)

    expect(document.querySelector('[data-wework-annotation="adjustments"]')).not.toBeNull()
    expect(
      document.querySelectorAll('[data-wework-annotation="adjustment-row"]').length
    ).toBeGreaterThan(0)
    expect(document.querySelector('[data-wework-annotation="adjustment-color"]')).not.toBeNull()
    expect(
      document.querySelector('[data-wework-annotation="adjustment-font-weight"]')
    ).not.toBeNull()
    expect(
      document.querySelector('[data-wework-annotation="adjustment-font-family"]')
    ).not.toBeNull()
    expect(document.querySelector('[data-wework-annotation="adjustment-width"]')).not.toBeNull()
  })

  test('resets a draft adjustment back to its baseline', () => {
    const target = document.querySelector<HTMLElement>('#first-target')!
    target.style.color = 'blue'
    openEditor(target)
    click(document.querySelector('[data-wework-annotation="adjust-toggle"]')!)

    const color = document.querySelector<HTMLInputElement>(
      '[data-wework-annotation="adjustment-color"]'
    )!
    color.value = '#ff0000'
    color.dispatchEvent(new Event('input', { bubbles: true }))
    expect(target.style.color).toBe('rgb(255, 0, 0)')

    click(document.querySelector('[data-wework-annotation="reset-color"]')!)
    expect(target.style.color).toBe('blue')
    expect(document.querySelector('[data-wework-annotation="adjustment-color"]')).not.toBeNull()
  })

  test('scrubs numeric values with pointer movement', () => {
    const target = document.querySelector<HTMLElement>('#first-target')!
    openEditor(target)
    click(document.querySelector('[data-wework-annotation="adjust-toggle"]')!)

    const width = document.querySelector<HTMLInputElement>(
      '[data-wework-annotation="adjustment-width"]'
    )!
    width.value = '120'
    width.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, clientY: 100 })
    )
    width.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientY: 96 })
    )
    width.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }))
    expect(target.style.width).toBe('121px')
  })

  test('closes the editor on Escape even while focused in an adjustment field', () => {
    const target = document.querySelector<HTMLElement>('#first-target')!
    openEditor(target)
    click(document.querySelector('[data-wework-annotation="adjust-toggle"]')!)
    const color = document.querySelector<HTMLInputElement>(
      '[data-wework-annotation="adjustment-color"]'
    )!
    color.focus()
    color.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    )
    expect(document.querySelector('[data-wework-annotation="editor"]')).toBeNull()
  })

  test('intercepts link clicks instead of navigating away', () => {
    const link = document.createElement('a')
    link.href = 'https://example.com'
    link.textContent = 'example link'
    document.querySelector('main')!.appendChild(link)
    setElementRect(link, 300, 200)
    elementsFromPointTarget = link
    const blocker = document.querySelector<HTMLElement>('[data-wework-annotation="blocker"]')!
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    blocker.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(document.querySelector('[data-wework-annotation="editor"]')).not.toBeNull()
  })

  test('creates a fresh session when the page url changes', () => {
    const input = openEditor(document.querySelector('#first-target')!)
    input!.value = 'First comment'
    input!.dispatchEvent(new Event('input', { bubbles: true }))
    click(saveButton()!)
    expect(annotationWindow.__WEWORK_BROWSER_ANNOTATION__?.getSnapshot().annotations).toHaveLength(
      1
    )

    annotationWindow.__WEWORK_BROWSER_ANNOTATION__!.scope.url = 'https://other.example/page'
    window.eval(browserAnnotationInjectionScript({ browserTabId: 'test-browser' }))

    expect(annotationWindow.__WEWORK_BROWSER_ANNOTATION__?.getSnapshot().annotations).toEqual([])
  })

  test('only rolls back overridden styles, preserving page-driven updates', () => {
    const target = document.querySelector<HTMLElement>('#first-target')!
    target.style.color = 'blue'
    const input = openEditor(target)
    input!.value = 'Use a stronger color'
    input!.dispatchEvent(new Event('input', { bubbles: true }))
    click(document.querySelector('[data-wework-annotation="adjust-toggle"]')!)

    const color = document.querySelector<HTMLInputElement>(
      '[data-wework-annotation="adjustment-color"]'
    )!
    color.value = '#ff0000'
    color.dispatchEvent(new Event('input', { bubbles: true }))
    expect(target.style.color).toBe('rgb(255, 0, 0)')
    click(saveButton()!)

    target.style.backgroundColor = 'yellow'
    annotationWindow.__WEWORK_BROWSER_ANNOTATION__?.suspend()

    expect(target.style.color).toBe('blue')
    expect(target.style.backgroundColor).toBe('yellow')
  })

  test('keeps the page new value when the page overrides an annotated property', () => {
    const target = document.querySelector<HTMLElement>('#first-target')!
    target.style.color = 'blue'
    const input = openEditor(target)
    input!.value = 'Use a stronger color'
    input!.dispatchEvent(new Event('input', { bubbles: true }))
    click(document.querySelector('[data-wework-annotation="adjust-toggle"]')!)

    const color = document.querySelector<HTMLInputElement>(
      '[data-wework-annotation="adjustment-color"]'
    )!
    color.value = '#ff0000'
    color.dispatchEvent(new Event('input', { bubbles: true }))
    click(saveButton()!)
    expect(target.style.color).toBe('rgb(255, 0, 0)')

    target.style.color = 'green'
    annotationWindow.__WEWORK_BROWSER_ANNOTATION__?.suspend()

    expect(target.style.color).toBe('green')
  })
})
