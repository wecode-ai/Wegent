// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest'
import { controlInlineVisualizationFrame } from './e2e-inline-visualization.js'

const environment = {
  VITE_WEWORK_E2E: 'true',
  WEWORK_E2E_CONTROL_URL: 'http://127.0.0.1:1234',
}
const url = 'blob:http://127.0.0.1:1234/calculator'

function target() {
  let attached = false
  const hitTest = vi.fn(() => document.querySelector<Element>('iframe'))
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: hitTest,
  })
  const frame = {
    url,
    processId: 202,
    executeJavaScript: vi.fn(async (script: string) => window.eval(script)),
  }
  const contents = {
    isDestroyed: () => false,
    debugger: {
      attach: vi.fn(() => {
        attached = true
      }),
      detach: vi.fn(() => {
        attached = false
      }),
      isAttached: vi.fn(() => attached),
      sendCommand: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({})),
      on: vi.fn(),
      off: vi.fn(),
    },
    mainFrame: {
      processId: 101,
      executeJavaScript: vi.fn(async (script: string) => window.eval(script)),
      frames: [frame],
    },
  }
  return { contents, frame, hitTest }
}

function visibleWheelTarget() {
  const result = target()
  document.body.innerHTML = `<iframe data-testid="codex-inline-visualization-frame" src="${url}"></iframe><section id="blank"></section>`
  const blank = document.querySelector<HTMLElement>('#blank')!
  vi.spyOn(document.querySelector('iframe')!, 'getBoundingClientRect').mockReturnValue({
    left: 100,
    top: 150,
    right: 600,
    bottom: 450,
  } as DOMRect)
  vi.spyOn(blank, 'getBoundingClientRect').mockReturnValue({
    left: 10,
    top: 20,
    right: 210,
    bottom: 100,
  } as DOMRect)
  return { ...result, blank }
}

function request(action = 'text', selector = '#result', value?: string) {
  return { url, action, selector, value }
}

function observeRootWheelProbe() {
  const added = vi.spyOn(window, 'addEventListener')
  const removed = vi.spyOn(window, 'removeEventListener')
  return {
    listener: () => {
      const listener = added.mock.calls.find(([type]) => type === 'wheel')?.[1]
      expect(typeof listener).toBe('function')
      return listener as EventListener
    },
    expectCleaned: () => {
      const listener = added.mock.calls.find(([type]) => type === 'wheel')?.[1]
      expect(added).toHaveBeenCalledWith('wheel', listener, { capture: true, passive: true })
      expect(removed).toHaveBeenCalledWith('wheel', listener, true)
    },
  }
}

afterEach(() => {
  expect(
    Object.getOwnPropertyNames(window).filter(key =>
      key.startsWith('__weworkInlineVisualizationWheel_')
    )
  ).toEqual([])
  vi.restoreAllMocks()
  vi.useRealTimers()
  document.body.replaceChildren()
})

describe('inline visualization verification controls', () => {
  test.each([
    {},
    { VITE_WEWORK_E2E: 'true' },
    { WEWORK_E2E_CONTROL_URL: environment.WEWORK_E2E_CONTROL_URL },
  ])('requires both isolated E2E signals before inspecting frames', async disabled => {
    const { contents, frame } = target()
    await expect(
      controlInlineVisualizationFrame(contents, request(), disabled)
    ).rejects.toMatchObject({ code: 'e2e_control_required' })
    expect(contents.mainFrame.executeJavaScript).not.toHaveBeenCalled()
    expect(frame.executeJavaScript).not.toHaveBeenCalled()
    expect(contents.debugger.attach).not.toHaveBeenCalled()
  })

  test('rejects a loaded blob that is not an actual visualization iframe', async () => {
    const { contents, frame } = target()
    document.body.innerHTML = `<iframe src="${url}"></iframe>`
    await expect(
      controlInlineVisualizationFrame(contents, request(), environment)
    ).rejects.toMatchObject({ code: 'e2e_frame_unavailable' })
    expect(frame.executeJavaScript).not.toHaveBeenCalled()
    expect(contents.debugger.attach).not.toHaveBeenCalled()
  })

  test('does not control a nested frame when its direct parent is not the main view', async () => {
    vi.useFakeTimers()
    const { contents, frame } = target()
    document.body.innerHTML = `<iframe data-testid="codex-inline-visualization-frame" src="${url}"></iframe>`
    contents.mainFrame.frames = []
    const rejected = expect(
      controlInlineVisualizationFrame(contents, request(), environment)
    ).rejects.toMatchObject({ code: 'e2e_frame_unavailable' })
    await vi.advanceTimersByTimeAsync(10_000)
    await rejected
    expect(frame.executeJavaScript).not.toHaveBeenCalled()
  })

  test('waits for a newly mounted frame without retrying its action', async () => {
    vi.useFakeTimers()
    const { contents, frame } = target()
    document.body.innerHTML = `<iframe data-testid="codex-inline-visualization-frame" src="${url}"></iframe><output id="result">ready</output>`
    contents.mainFrame.frames = []
    const result = controlInlineVisualizationFrame(contents, request(), environment)
    await vi.advanceTimersByTimeAsync(25)
    contents.mainFrame.frames = [frame]
    await vi.advanceTimersByTimeAsync(25)
    await expect(result).resolves.toBe('ready')
    expect(frame.executeJavaScript).toHaveBeenCalledOnce()
  })

  test.each([
    { ...request(), url: 'https://example.com' },
    { ...request(), action: 'evaluate', source: 'process.exit()' },
    { ...request(), selector: '' },
    { ...request(), value: {} },
    { ...request('wheel'), deltaY: Number.POSITIVE_INFINITY },
    { ...request('wheel'), deltaX: '100' },
  ])('rejects unsupported controls before executing JavaScript', async params => {
    const { contents } = target()
    await expect(
      controlInlineVisualizationFrame(contents, params, environment)
    ).rejects.toMatchObject({ code: 'e2e_invalid_target' })
    expect(contents.mainFrame.executeJavaScript).not.toHaveBeenCalled()
    expect(contents.debugger.attach).not.toHaveBeenCalled()
  })

  test('reports an unavailable main view', async () => {
    await expect(
      controlInlineVisualizationFrame(null, request(), environment)
    ).rejects.toMatchObject({ code: 'e2e_view_unavailable' })
    const { contents } = target()
    contents.isDestroyed = () => true
    await expect(
      controlInlineVisualizationFrame(contents, request(), environment)
    ).rejects.toMatchObject({ code: 'e2e_view_unavailable' })
  })

  test('runs only fixed DOM actions and treats selector and value as data', async () => {
    const { contents } = target()
    document.body.innerHTML = `
      <iframe data-testid="codex-inline-visualization-frame" src="${url}"></iframe>
      <input id="principal" value="100000" aria-label="Principal">
      <output id="result">100000</output>
      <button id="reset" type="button">Reset</button>
    `
    const input = document.querySelector<HTMLInputElement>('#principal')!
    const result = document.querySelector<HTMLOutputElement>('#result')!
    input.addEventListener('input', () => {
      result.textContent = input.value
    })
    document.querySelector('#reset')!.addEventListener('click', () => {
      result.textContent = 'reset'
    })

    const control = (action: string, selector: string, value?: string) =>
      controlInlineVisualizationFrame(contents, request(action, selector, value), environment)
    await expect(control('attribute', '#principal', 'aria-label')).resolves.toBe('Principal')
    await control('fill', '#principal', '200000')
    await expect(control('value', '#principal')).resolves.toBe('200000')
    await expect(control('text', '#result')).resolves.toBe('200000')
    const literal = '"); globalThis.injected = true; ("'
    await control('fill', '#principal', literal)
    await expect(control('text', '#result')).resolves.toBe(literal)
    expect(Reflect.get(globalThis, 'injected')).toBeUndefined()
    await expect(control('click', '#absent')).rejects.toThrow('target not found')
    await expect(control('fill', '#result', 'invalid')).rejects.toThrow('not an input')
    await control('click', '#reset')
    await expect(control('text', '#result')).resolves.toBe('reset')
  })

  test.each(['codex-inline-visualization-frame', 'mcp-app-frame'])(
    'observes a missing asynchronous result without swallowing action failures: %s',
    async testId => {
      const { contents, frame } = target()
      document.body.innerHTML = `<iframe data-testid="${testId}" src="${url}"></iframe>`
      const control = (action: string) =>
        controlInlineVisualizationFrame(contents, request(action), environment)

      await expect(control('text')).resolves.toBeNull()
      await expect(control('fill')).rejects.toThrow('target not found')
      await expect(control('click')).rejects.toThrow('target not found')

      const result = document.createElement('output')
      result.id = 'result'
      result.textContent = 'Open conversation'
      document.body.append(result)
      await expect(control('text')).resolves.toBe('Open conversation')
      expect(frame.executeJavaScript).toHaveBeenCalledTimes(4)
    }
  )

  test('reads fixed geometry and sends native wheel input at the visible frame target', async () => {
    const { contents, blank } = visibleWheelTarget()
    const probe = observeRootWheelProbe()
    Object.defineProperty(blank, 'scrollHeight', { value: 700 })
    Object.defineProperty(blank, 'clientHeight', { value: 80 })
    blank.scrollTop = 120

    await expect(
      controlInlineVisualizationFrame(contents, request('metrics', '#blank'), environment)
    ).resolves.toMatchObject({ scrollTop: 120, scrollHeight: 700, clientHeight: 80 })
    await expect(
      controlInlineVisualizationFrame(
        contents,
        {
          ...request('wheel', '#blank'),
          deltaX: 8,
          deltaY: -40,
        },
        environment
      )
    ).resolves.toMatchObject({
      backend: 'chromium-input-dispatch',
      x: 210,
      y: 210,
      deltaX: 8,
      deltaY: -40,
      frameProcessId: 202,
      mainFrameProcessId: 101,
      probe: {
        before: {
          frameRect: { left: 100, top: 150, right: 600, bottom: 450 },
          ownsPoint: true,
          hit: { tag: 'iframe', testId: 'codex-inline-visualization-frame' },
        },
        afterMove: { ownsPoint: true },
        afterWheel: { wheelEvents: [] },
      },
    })
    expect(contents.debugger.sendCommand.mock.calls).toEqual([
      ['Input.dispatchMouseEvent', { type: 'mouseMoved', x: 210, y: 210 }],
      ['Input.dispatchMouseEvent', { type: 'mouseWheel', x: 210, y: 210, deltaX: 8, deltaY: -40 }],
    ])
    expect(blank.scrollTop).toBe(120)
    probe.expectCleaned()
  })

  test('uses the same native wheel path for an owned MCP App document', async () => {
    const { contents, frame } = visibleWheelTarget()
    const mcpUrl = 'codex-sandbox://card.web-sandbox.oaiusercontent.com/mcp-app.html'
    const element = document.querySelector<HTMLIFrameElement>('iframe')!
    element.dataset.testid = 'mcp-app-frame'
    element.src = mcpUrl
    frame.url = mcpUrl
    await expect(
      controlInlineVisualizationFrame(
        contents,
        { url: mcpUrl, action: 'wheel', selector: '#blank', deltaY: -120 },
        environment
      )
    ).resolves.toMatchObject({
      backend: 'chromium-input-dispatch',
      deltaY: -120,
      probe: { before: { ownsPoint: true, hit: { testId: 'mcp-app-frame' } } },
    })
    expect(contents.debugger.sendCommand).toHaveBeenCalledWith('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: 210,
      y: 210,
      deltaX: 0,
      deltaY: -120,
    })
  })

  test('clips native wheel coordinates to the visible conversation viewport', async () => {
    const { contents } = target()
    document.body.innerHTML = `<div id="viewport" style="overflow-y:auto"><iframe data-testid="codex-inline-visualization-frame" src="${url}"></iframe></div><section id="blank"></section>`
    vi.spyOn(document.querySelector('#viewport')!, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 200,
      right: 600,
      bottom: 500,
    } as DOMRect)
    vi.spyOn(document.querySelector('iframe')!, 'getBoundingClientRect').mockReturnValue({
      left: 100,
      top: 100,
      right: 600,
      bottom: 400,
    } as DOMRect)
    vi.spyOn(document.querySelector('#blank')!, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 50,
      right: 100,
      bottom: 150,
    } as DOMRect)

    await controlInlineVisualizationFrame(
      contents,
      {
        ...request('wheel', '#blank'),
        deltaY: 80,
      },
      environment
    )

    expect(contents.debugger.sendCommand).toHaveBeenLastCalledWith('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: 150,
      y: 225,
      deltaX: 0,
      deltaY: 80,
    })
  })

  test('rejects offscreen wheel targets without sending input', async () => {
    const { contents } = target()
    document.body.innerHTML = `<iframe data-testid="codex-inline-visualization-frame" src="${url}"></iframe><section id="blank"></section>`
    vi.spyOn(document.querySelector('iframe')!, 'getBoundingClientRect').mockReturnValue({
      left: 100,
      top: 100,
      right: 600,
      bottom: 400,
    } as DOMRect)
    vi.spyOn(document.querySelector('#blank')!, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: -100,
      right: 100,
      bottom: -50,
    } as DOMRect)

    await expect(
      controlInlineVisualizationFrame(
        contents,
        {
          ...request('wheel', '#blank'),
          deltaY: -80,
        },
        environment
      )
    ).rejects.toMatchObject({ code: 'e2e_target_not_visible' })
    expect(contents.debugger.sendCommand).not.toHaveBeenCalled()
    expect(contents.debugger.attach).not.toHaveBeenCalled()
  })

  test.each([Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects non-finite target geometry before attaching the input protocol (%s)',
    async left => {
      const { contents, blank } = visibleWheelTarget()
      vi.mocked(blank.getBoundingClientRect).mockReturnValue({
        left,
        top: 20,
        right: 210,
        bottom: 100,
      } as DOMRect)
      await expect(
        controlInlineVisualizationFrame(
          contents,
          { ...request('wheel', '#blank'), deltaY: 80 },
          environment
        )
      ).rejects.toMatchObject({ code: 'e2e_invalid_geometry' })
      expect(contents.debugger.sendCommand).not.toHaveBeenCalled()
      expect(contents.debugger.attach).not.toHaveBeenCalled()
    }
  )

  test('awaits each native input acknowledgement before sending or releasing the next step', async () => {
    const { contents } = visibleWheelTarget()
    let releaseMove!: () => void
    let releaseWheel!: () => void
    contents.debugger.sendCommand
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            releaseMove = () => resolve({})
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            releaseWheel = () => resolve({})
          })
      )
    const result = controlInlineVisualizationFrame(
      contents,
      { ...request('wheel', '#blank'), deltaY: 80 },
      environment
    )
    await vi.waitFor(() => expect(contents.debugger.sendCommand).toHaveBeenCalledTimes(1))
    expect(contents.debugger.detach).not.toHaveBeenCalled()
    releaseMove()
    await vi.waitFor(() => expect(contents.debugger.sendCommand).toHaveBeenCalledTimes(2))
    expect(contents.debugger.detach).not.toHaveBeenCalled()
    releaseWheel()
    await expect(result).resolves.toMatchObject({ backend: 'chromium-input-dispatch' })
    expect(contents.debugger.detach).toHaveBeenCalledOnce()
  })

  test.each(['mouseMoved', 'mouseWheel'])(
    'propagates a rejected %s acknowledgement',
    async type => {
      const { contents } = visibleWheelTarget()
      const probe = observeRootWheelProbe()
      const failure = new Error(`${type} rejected`)
      contents.debugger.sendCommand.mockImplementation(async (_method, params) => {
        if ((params as { type: string }).type === type) throw failure
        return {}
      })
      await expect(
        controlInlineVisualizationFrame(
          contents,
          { ...request('wheel', '#blank'), deltaY: 80 },
          environment
        )
      ).rejects.toBe(failure)
      expect(contents.debugger.sendCommand).toHaveBeenCalledTimes(type === 'mouseMoved' ? 1 : 2)
      expect(contents.debugger.detach).toHaveBeenCalledOnce()
      probe.expectCleaned()
    }
  )

  test.each(['frame', 'target', 'overlay', 'removed'])(
    'does not send wheel input when the fixed point loses its %s target after move acknowledgement',
    async change => {
      const { contents, blank, hitTest } = visibleWheelTarget()
      const probe = observeRootWheelProbe()
      let releaseMove!: () => void
      contents.debugger.sendCommand.mockImplementationOnce(
        () => new Promise(resolve => (releaseMove = () => resolve({})))
      )
      const operation = controlInlineVisualizationFrame(
        contents,
        { ...request('wheel', '#blank'), deltaY: 80 },
        environment
      )
      const rejected = expect(operation).rejects.toMatchObject({
        code: 'e2e_target_changed',
        details: {
          point: { x: 210, y: 210 },
          before: { ownsPoint: true },
          after: { ownsPoint: change !== 'overlay' },
        },
      })
      await vi.waitFor(() => expect(contents.debugger.sendCommand).toHaveBeenCalledOnce())
      if (change === 'frame') {
        vi.mocked(document.querySelector('iframe')!.getBoundingClientRect).mockReturnValue({
          left: 100,
          top: 300,
          right: 600,
          bottom: 600,
        } as DOMRect)
      } else if (change === 'target') {
        vi.mocked(blank.getBoundingClientRect).mockReturnValue({
          left: 10,
          top: 100,
          right: 210,
          bottom: 180,
        } as DOMRect)
      } else if (change === 'removed') {
        blank.remove()
      } else {
        const overlay = document.createElement('button')
        overlay.dataset.testid = 'covering-overlay'
        overlay.textContent = 'Private text must never be included in probe descriptors'
        document.body.append(overlay)
        hitTest.mockReturnValue(overlay)
      }
      releaseMove()
      await rejected
      expect(contents.debugger.sendCommand).toHaveBeenCalledOnce()
      expect(contents.debugger.detach).toHaveBeenCalledOnce()
      probe.expectCleaned()
    }
  )

  test('rejects an initially covered point without sending mouse input', async () => {
    const { contents, hitTest } = visibleWheelTarget()
    const probe = observeRootWheelProbe()
    const overlay = document.createElement('div')
    overlay.dataset.testid = 'initial-overlay'
    document.body.append(overlay)
    hitTest.mockReturnValue(overlay)
    await expect(
      controlInlineVisualizationFrame(
        contents,
        { ...request('wheel', '#blank'), deltaY: 80 },
        environment
      )
    ).rejects.toMatchObject({
      code: 'e2e_target_changed',
      details: { after: { ownsPoint: false, hit: { tag: 'div', testId: 'initial-overlay' } } },
    })
    expect(contents.debugger.sendCommand).not.toHaveBeenCalled()
    expect(contents.debugger.detach).toHaveBeenCalledOnce()
    probe.expectCleaned()
  })

  test.each(['initial', 'after-move'])(
    'identifies the nearest marked ancestor of an SVG covering the %s input point',
    async stage => {
      const { contents, hitTest } = visibleWheelTarget()
      const probe = observeRootWheelProbe()
      const outer = document.createElement('div')
      outer.id = 'outer-owner'
      outer.innerHTML =
        '<button data-testid="scroll-to-bottom-button" class="floating-action"><svg><path></path></svg></button>'
      outer.append('Private control label')
      document.body.append(outer)
      const path = outer.querySelector('path')!
      if (stage === 'initial') hitTest.mockReturnValue(path)
      else {
        contents.debugger.sendCommand.mockImplementation(async (_method, params) => {
          if ((params as { type: string }).type === 'mouseMoved') hitTest.mockReturnValue(path)
          return {}
        })
      }
      const failure = await controlInlineVisualizationFrame(
        contents,
        { ...request('wheel', '#blank'), deltaY: 80 },
        environment
      ).catch(error => error)
      expect(failure).toMatchObject({
        code: 'e2e_target_changed',
        details: {
          after: {
            ownsPoint: false,
            hit: { tag: 'path' },
            hitAncestor: {
              tag: 'button',
              id: null,
              testId: 'scroll-to-bottom-button',
              className: 'floating-action',
            },
          },
        },
      })
      expect(JSON.stringify(failure)).not.toContain('Private control label')
      expect(contents.debugger.sendCommand).toHaveBeenCalledTimes(stage === 'initial' ? 0 : 1)
      expect(contents.debugger.detach).toHaveBeenCalledOnce()
      probe.expectCleaned()
    }
  )

  test.each([8, 9])('bounds marked-ancestor traversal and descriptors at depth %s', async depth => {
    const { contents, hitTest } = visibleWheelTarget()
    const overlay = document.createElement('div')
    overlay.id = 'i'.repeat(300)
    overlay.dataset.testid = 't'.repeat(300)
    overlay.className = 'c'.repeat(300)
    document.body.append(overlay)
    let parent = overlay
    for (let index = 1; index < depth; index += 1) {
      parent = parent.appendChild(document.createElement('div'))
    }
    const child = parent.appendChild(document.createElement('span'))
    hitTest.mockReturnValue(child)
    await expect(
      controlInlineVisualizationFrame(
        contents,
        { ...request('wheel', '#blank'), deltaY: 80 },
        environment
      )
    ).rejects.toMatchObject({
      code: 'e2e_target_changed',
      details: {
        after: {
          hitAncestor:
            depth === 8
              ? {
                  tag: 'div',
                  id: 'i'.repeat(256),
                  testId: 't'.repeat(256),
                  className: 'c'.repeat(256),
                }
              : null,
        },
      },
    })
    expect(contents.debugger.sendCommand).not.toHaveBeenCalled()
    expect(contents.debugger.detach).toHaveBeenCalledOnce()
  })

  test('allows subpixel movement while the fixed point still hits the owned target', async () => {
    const { contents } = visibleWheelTarget()
    contents.debugger.sendCommand.mockImplementation(async (_method, params) => {
      if ((params as { type: string }).type === 'mouseMoved') {
        vi.mocked(document.querySelector('iframe')!.getBoundingClientRect).mockReturnValue({
          left: 100.25,
          top: 150.25,
          right: 600.25,
          bottom: 450.25,
        } as DOMRect)
      }
      return {}
    })
    await expect(
      controlInlineVisualizationFrame(
        contents,
        { ...request('wheel', '#blank'), deltaY: 80 },
        environment
      )
    ).resolves.toMatchObject({ x: 210, y: 210 })
    expect(contents.debugger.sendCommand).toHaveBeenCalledTimes(2)
  })

  test('records bounded trusted root wheel targets without collecting text or synthetic bridge events', async () => {
    const { contents } = visibleWheelTarget()
    const probe = observeRootWheelProbe()
    const rootTarget = document.createElement('button')
    rootTarget.id = 'root-target'
    rootTarget.dataset.testid = 'root-target-test'
    rootTarget.className = 'root-target-class'
    rootTarget.textContent = 'Private control label'
    document.body.append(rootTarget)
    contents.debugger.sendCommand.mockImplementation(async (_method, params) => {
      if ((params as { type: string }).type === 'mouseWheel') {
        window.dispatchEvent(new WheelEvent('wheel', { deltaY: 80 }))
        for (let index = 0; index < 10; index += 1) {
          probe.listener()({
            isTrusted: true,
            target: rootTarget,
            clientX: 210,
            clientY: 210,
            deltaX: 0,
            deltaY: index,
            deltaMode: 0,
            cancelable: true,
            defaultPrevented: false,
          } as unknown as Event)
        }
      }
      return {}
    })
    const result = await controlInlineVisualizationFrame(
      contents,
      { ...request('wheel', '#blank'), deltaY: 80 },
      environment
    )
    expect(result).toMatchObject({
      probe: {
        afterWheel: {
          wheelEvents: Array.from({ length: 8 }, (_, index) => ({
            trusted: true,
            deltaY: index + 2,
            target: {
              tag: 'button',
              id: 'root-target',
              testId: 'root-target-test',
              className: 'root-target-class',
            },
          })),
        },
      },
    })
    expect(JSON.stringify(result)).not.toContain(rootTarget.textContent)
    probe.expectCleaned()
  })

  test('identifies a trusted root wheel target through its marked ancestor', async () => {
    const { contents } = visibleWheelTarget()
    const probe = observeRootWheelProbe()
    const owner = document.createElement('button')
    owner.id = 'root-wheel-owner'
    owner.innerHTML = '<svg><path></path></svg>'
    owner.append('Private root wheel label')
    document.body.append(owner)
    contents.debugger.sendCommand.mockImplementation(async (_method, params) => {
      if ((params as { type: string }).type === 'mouseWheel') {
        probe.listener()({
          isTrusted: true,
          target: owner.querySelector('path'),
          clientX: 210,
          clientY: 210,
          deltaX: 0,
          deltaY: 80,
          deltaMode: 0,
          cancelable: true,
          defaultPrevented: false,
        } as unknown as Event)
      }
      return {}
    })
    const result = await controlInlineVisualizationFrame(
      contents,
      { ...request('wheel', '#blank'), deltaY: 80 },
      environment
    )
    expect(result).toMatchObject({
      probe: {
        afterWheel: {
          wheelEvents: [
            {
              target: { tag: 'path' },
              targetAncestor: { tag: 'button', id: 'root-wheel-owner' },
            },
          ],
        },
      },
    })
    expect(JSON.stringify(result)).not.toContain('Private root wheel label')
    expect(contents.debugger.sendCommand).toHaveBeenCalledTimes(2)
    probe.expectCleaned()
  })

  test.each(['mouseMoved', 'mouseWheel'])(
    'cleans the observer and lease when the view is destroyed during %s acknowledgement',
    async type => {
      const { contents } = visibleWheelTarget()
      const probe = observeRootWheelProbe()
      let destroyed = false
      contents.isDestroyed = () => destroyed
      contents.debugger.sendCommand.mockImplementation(async (_method, params) => {
        if ((params as { type: string }).type === type) destroyed = true
        return {}
      })
      await expect(
        controlInlineVisualizationFrame(
          contents,
          { ...request('wheel', '#blank'), deltaY: 80 },
          environment
        )
      ).rejects.toMatchObject({ code: 'e2e_view_unavailable' })
      expect(contents.debugger.sendCommand).toHaveBeenCalledTimes(type === 'mouseMoved' ? 1 : 2)
      expect(contents.debugger.detach).toHaveBeenCalledOnce()
      probe.expectCleaned()
    }
  )

  test.each([false, true])(
    'reports cleanup failure without replacing a primary input failure (%s)',
    async inputFails => {
      const { contents } = visibleWheelTarget()
      const probe = observeRootWheelProbe()
      const inputFailure = new Error('wheel acknowledgement failed')
      const cleanupFailure = new Error('cleanup acknowledgement failed')
      const execute = contents.mainFrame.executeJavaScript.getMockImplementation()!
      contents.mainFrame.executeJavaScript.mockImplementation(async script => {
        const result = await execute(script)
        if (script.includes('"action":"cleanup"')) throw cleanupFailure
        return result
      })
      contents.debugger.sendCommand.mockImplementation(async (_method, params) => {
        if (inputFails && (params as { type: string }).type === 'mouseWheel') throw inputFailure
        return {}
      })
      await expect(
        controlInlineVisualizationFrame(
          contents,
          { ...request('wheel', '#blank'), deltaY: 80 },
          environment
        )
      ).rejects.toBe(inputFails ? inputFailure : cleanupFailure)
      expect(contents.debugger.detach).toHaveBeenCalledOnce()
      probe.expectCleaned()
    }
  )
})
