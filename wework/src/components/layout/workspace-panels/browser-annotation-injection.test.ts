import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { browserAnnotationInjectionScript } from './WorkspaceBrowserPanel'

interface PublishedAnnotation {
  comment: string
  number: number
  text: string
}

type AnnotationWindow = Window & {
  __weworkBrowserAnnotationClear?: () => void
  __weworkBrowserAnnotationClose?: () => void
  __weworkBrowserAnnotationConsume?: () => PublishedAnnotation[]
}

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
  return document.querySelector<HTMLInputElement>('[data-wework-annotation="editor"] input')
}

function publishButton() {
  return document.querySelector<HTMLButtonElement>('[data-wework-annotation="editor"] button')
}

describe('browser annotation injection', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <main>
        <button id="first-target">First target</button>
        <button id="second-target">Second target</button>
      </main>
    `
    setElementRect(document.querySelector('#first-target')!, 20, 30)
    setElementRect(document.querySelector('#second-target')!, 180, 90)
    window.eval(browserAnnotationInjectionScript())
  })

  afterEach(() => {
    annotationWindow.__weworkBrowserAnnotationClose?.()
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  test('publishes exactly one annotation without reopening the editor', () => {
    const input = openEditor(document.querySelector('#first-target')!)
    expect(input).not.toBeNull()

    input!.value = 'First comment'
    click(publishButton()!)

    expect(document.querySelectorAll('[data-wework-annotation="editor"]')).toHaveLength(0)
    expect(document.querySelectorAll('[data-wework-annotation="box"]')).toHaveLength(1)
    expect(document.querySelector('[data-wework-annotation="box"] span')).toHaveTextContent('1')
    expect(annotationWindow.__weworkBrowserAnnotationConsume?.()).toEqual([
      expect.objectContaining({
        comment: 'First comment',
        number: 1,
        text: 'First target',
      }),
    ])
  })

  test('publishes with Enter without selecting the editor as a new target', () => {
    const input = openEditor(document.querySelector('#first-target')!)
    input!.value = 'Keyboard comment'
    input!.dispatchEvent(
      new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'Enter',
      })
    )

    expect(document.querySelectorAll('[data-wework-annotation="editor"]')).toHaveLength(0)
    expect(annotationWindow.__weworkBrowserAnnotationConsume?.()).toEqual([
      expect.objectContaining({ comment: 'Keyboard comment', number: 1 }),
    ])
  })

  test('keeps consecutive annotations paired with their own selection boxes', () => {
    const firstInput = openEditor(document.querySelector('#first-target')!)
    firstInput!.value = 'First comment'
    click(publishButton()!)

    const secondInput = openEditor(document.querySelector('#second-target')!)
    secondInput!.value = 'Second comment'
    click(publishButton()!)

    expect(document.querySelectorAll('[data-wework-annotation="editor"]')).toHaveLength(0)
    expect(
      Array.from(document.querySelectorAll('[data-wework-annotation="box"] span')).map(
        badge => badge.textContent
      )
    ).toEqual(['1', '2'])
    expect(annotationWindow.__weworkBrowserAnnotationConsume?.()).toEqual([
      expect.objectContaining({ comment: 'First comment', number: 1, text: 'First target' }),
      expect.objectContaining({ comment: 'Second comment', number: 2, text: 'Second target' }),
    ])
  })
})
