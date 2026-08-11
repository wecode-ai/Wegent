import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { browserAnnotationInjectionScript } from './browser-annotation/injection-script'

interface RuntimeApi {
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
  target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
  click(target)
  return document.querySelector<HTMLInputElement>('[data-wework-annotation="comment-input"]')
}

function saveButton() {
  return document.querySelector<HTMLButtonElement>('[data-wework-annotation="save"]')
}

describe('browser annotation injection', () => {
  beforeEach(() => {
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
    expect(document.querySelectorAll('[data-wework-annotation="box"]')).toHaveLength(1)
  })

  test('edits a published annotation without changing its number', () => {
    const input = openEditor(document.querySelector('#first-target')!)
    input!.value = 'First comment'
    input!.dispatchEvent(new Event('input', { bubbles: true }))
    click(saveButton()!)
    click(document.querySelector('[data-wework-annotation="badge"]')!)

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

  test('deletes one annotation after the injected confirmation', () => {
    const input = openEditor(document.querySelector('#first-target')!)
    input!.value = 'First comment'
    input!.dispatchEvent(new Event('input', { bubbles: true }))
    click(saveButton()!)
    click(document.querySelector('[data-wework-annotation="badge"]')!)
    click(document.querySelector('[data-wework-annotation="delete"]')!)

    expect(document.querySelector('[data-wework-annotation="delete-confirmation"]')).not.toBeNull()
    click(document.querySelector('[data-wework-annotation="delete-confirm"]')!)
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
    expect(document.querySelectorAll('[data-wework-annotation="box"]')).toHaveLength(0)
    expect(annotationWindow.__WEWORK_BROWSER_ANNOTATION__?.getSnapshot().annotations).toHaveLength(
      1
    )

    annotationWindow.__WEWORK_BROWSER_ANNOTATION__?.resume()
    expect(document.querySelectorAll('[data-wework-annotation="box"]')).toHaveLength(1)
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
})
