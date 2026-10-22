import { describe, expect, test, vi } from 'vitest'
import { createMarkdownWindowingScope } from './MarkdownWindowingScope'

describe('Markdown windowing height cache', () => {
  test('reuses the exact measured content and width independently of chunk mounts', () => {
    const onChunkLayout = vi.fn()
    const scrollElementRef = { current: null }
    const scope = createMarkdownWindowingScope(scrollElementRef, onChunkLayout)

    expect(scope.scrollElementRef).toBe(scrollElementRef)
    expect(scope.getHeight('**Original content**', 736)).toBeUndefined()
    scope.setHeight('**Original content**', 736, 2406.78)

    expect(scope.getHeight('**Original content**', 736)).toBe(2406.78)
    expect(scope.getHeight('**Original content**', 735)).toBeUndefined()
    expect(scope.getHeight('**Updated content**', 736)).toBeUndefined()
    scope.setHeight('**Original content**', 736, 2412.5)
    expect(scope.getHeight('**Original content**', 736)).toBe(2412.5)

    const chunk = {} as HTMLElement
    scope.onChunkLayout(chunk)
    expect(onChunkLayout).toHaveBeenCalledExactlyOnceWith(chunk)
  })

  test('keeps height caches separate between conversation scopes', () => {
    const first = createMarkdownWindowingScope(undefined, vi.fn())
    const second = createMarkdownWindowingScope(undefined, vi.fn())
    first.setHeight('Same paragraph', 600, 180)

    expect(second.getHeight('Same paragraph', 600)).toBeUndefined()
  })

  test.each([0, -1, NaN, Infinity, -Infinity])('rejects invalid dimensions %s', invalid => {
    const scope = createMarkdownWindowingScope(undefined, vi.fn())
    scope.setHeight('Content', 600, 200)
    scope.setHeight('Content', invalid, 180)
    scope.setHeight('Content', 600, invalid)

    expect(scope.getHeight('Content', invalid)).toBeUndefined()
    expect(scope.getHeight('Content', 600)).toBe(200)
  })

  test('evicts the least recently used entry after 256 content-width pairs', () => {
    const scope = createMarkdownWindowingScope(undefined, vi.fn())
    for (let index = 0; index < 256; index += 1) {
      scope.setHeight(`Chunk ${index}`, 600, 120 + index)
    }
    expect(scope.getHeight('Chunk 0', 600)).toBe(120)

    scope.setHeight('Additional chunk', 600, 300)

    expect(scope.getHeight('Chunk 1', 600)).toBeUndefined()
    expect(scope.getHeight('Chunk 0', 600)).toBe(120)
    expect(scope.getHeight('Additional chunk', 600)).toBe(300)
  })

  test('bounds width variants in the same shared LRU budget', () => {
    const scope = createMarkdownWindowingScope(undefined, vi.fn())
    for (let width = 1; width <= 257; width += 1) {
      scope.setHeight('Content', width, 300)
    }

    expect(scope.getHeight('Content', 1)).toBeUndefined()
    expect(scope.getHeight('Content', 257)).toBe(300)
  })
})

describe('Markdown windowing viewport activation', () => {
  const viewport = {
    width: 600,
    height: 800,
    top: 100,
    bottom: 900,
  } as DOMRect

  function createScrollRef(rect = viewport) {
    const getBoundingClientRect = vi.fn(() => rect)
    return {
      current: { getBoundingClientRect } as unknown as HTMLElement,
      getBoundingClientRect,
    }
  }

  test('collects activations with one viewport read without rendering during checks', () => {
    const scrollRef = createScrollRef()
    const scope = createMarkdownWindowingScope(scrollRef, vi.fn())
    const firstRender = vi.fn()
    const secondRender = vi.fn()
    const firstCheck = vi.fn(() => firstRender)
    const inactiveCheck = vi.fn(() => undefined)
    const secondCheck = vi.fn(() => secondRender)
    scope.registerViewportCheck(firstCheck)
    scope.registerViewportCheck(inactiveCheck)
    scope.registerViewportCheck(secondCheck)

    const renders = scope.getViewportRenders()

    expect(renders).toEqual([firstRender, secondRender])
    expect(scrollRef.getBoundingClientRect).toHaveBeenCalledTimes(1)
    expect(firstCheck).toHaveBeenCalledExactlyOnceWith(viewport)
    expect(inactiveCheck).toHaveBeenCalledExactlyOnceWith(viewport)
    expect(secondCheck).toHaveBeenCalledExactlyOnceWith(viewport)
    expect(firstRender).not.toHaveBeenCalled()
    expect(secondRender).not.toHaveBeenCalled()
    renders.forEach(render => render())
    expect(firstRender).toHaveBeenCalledTimes(1)
    expect(secondRender).toHaveBeenCalledTimes(1)
  })

  test('unregisters detached chunks and avoids geometry reads without checks', () => {
    const scrollRef = createScrollRef()
    const scope = createMarkdownWindowingScope(scrollRef, vi.fn())
    const check = vi.fn(() => vi.fn())
    const unregister = scope.registerViewportCheck(check)
    unregister()

    expect(scope.getViewportRenders()).toEqual([])
    expect(check).not.toHaveBeenCalled()
    expect(scrollRef.getBoundingClientRect).not.toHaveBeenCalled()
  })

  test('returns no work when all chunks remain inactive', () => {
    const scrollRef = createScrollRef()
    const scope = createMarkdownWindowingScope(scrollRef, vi.fn())
    const check = vi.fn(() => undefined)
    scope.registerViewportCheck(check)

    expect(scope.getViewportRenders()).toEqual([])
    expect(check).toHaveBeenCalledExactlyOnceWith(viewport)
  })

  test.each([
    { width: 0, height: 800 },
    { width: 600, height: 0 },
  ])('does not activate chunks within a hidden viewport %s', dimensions => {
    const scrollRef = createScrollRef({
      ...viewport,
      ...dimensions,
    } as DOMRect)
    const scope = createMarkdownWindowingScope(scrollRef, vi.fn())
    const check = vi.fn(() => vi.fn())
    scope.registerViewportCheck(check)

    expect(scope.getViewportRenders()).toEqual([])
    expect(check).not.toHaveBeenCalled()
  })

  test.each([undefined, { current: null }])(
    'does not activate chunks without a mounted scroll root %s',
    scrollRef => {
      const scope = createMarkdownWindowingScope(scrollRef, vi.fn())
      const check = vi.fn(() => vi.fn())
      scope.registerViewportCheck(check)

      expect(scope.getViewportRenders()).toEqual([])
      expect(check).not.toHaveBeenCalled()
    }
  )
})
