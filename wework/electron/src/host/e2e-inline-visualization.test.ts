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
  return { contents, frame }
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

afterEach(() => {
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
    await expect(control('text', '#absent')).rejects.toThrow('target not found')
    await expect(control('fill', '#result', 'invalid')).rejects.toThrow('not an input')
    await control('click', '#reset')
    await expect(control('text', '#result')).resolves.toBe('reset')
  })

  test('reads fixed geometry and sends native wheel input at the visible frame target', async () => {
    const { contents, blank } = visibleWheelTarget()
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
    })
    expect(contents.debugger.sendCommand.mock.calls).toEqual([
      ['Input.dispatchMouseEvent', { type: 'mouseMoved', x: 210, y: 210 }],
      ['Input.dispatchMouseEvent', { type: 'mouseWheel', x: 210, y: 210, deltaX: 8, deltaY: -40 }],
    ])
    expect(blank.scrollTop).toBe(120)
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
    }
  )
})
