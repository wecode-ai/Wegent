import type { WebContents, WebFrameMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { HostCapabilityError } from './capability-router.js'
import { withDebuggerSession, type DebuggerTarget } from './debugger-session.js'

type VisualizationFrame = Pick<WebFrameMain, 'url' | 'executeJavaScript' | 'processId'>
type VisualizationContents = Pick<WebContents, 'isDestroyed'> &
  DebuggerTarget & {
    mainFrame: Pick<WebFrameMain, 'executeJavaScript' | 'processId'> & {
      frames: readonly VisualizationFrame[]
    }
  }

interface VisualizationRect {
  left: number
  top: number
  right: number
  bottom: number
}

interface VisualizationElementDescriptor {
  tag: string
  id: string | null
  testId: string | null
  className: string | null
}

interface VisualizationRootObservation {
  frameRect: VisualizationRect | null
  ownsPoint: boolean
  hit: VisualizationElementDescriptor | null
  hitAncestor: VisualizationElementDescriptor | null
}

interface VisualizationTargetObservation extends VisualizationRootObservation {
  targetRect: VisualizationRect | null
}

const ACTIONS = ['text', 'click', 'fill', 'attribute', 'value', 'metrics', 'wheel']
const INLINE_FRAME_SELECTOR =
  'iframe[data-testid="codex-inline-visualization-frame"], iframe[data-testid="mcp-app-frame"]'
const FRAME_READY_TIMEOUT_MS = 10_000

export async function controlInlineVisualizationFrame(
  contents: VisualizationContents | null,
  params: Record<string, unknown>,
  environment: NodeJS.ProcessEnv = process.env
): Promise<unknown> {
  if (!environment.WEWORK_E2E_CONTROL_URL || environment.VITE_WEWORK_E2E !== 'true') {
    throw new HostCapabilityError('e2e_control_required', 'An isolated E2E controller is required')
  }
  const { url, action, selector, value, deltaX = 0, deltaY = 0 } = params
  if (
    typeof url !== 'string' ||
    (!url.startsWith('blob:') && !url.startsWith('codex-sandbox:')) ||
    typeof action !== 'string' ||
    !ACTIONS.includes(action) ||
    typeof selector !== 'string' ||
    !selector.trim() ||
    (value !== undefined && typeof value !== 'string') ||
    (action === 'wheel' &&
      (typeof deltaX !== 'number' ||
        !Number.isFinite(deltaX) ||
        typeof deltaY !== 'number' ||
        !Number.isFinite(deltaY)))
  ) {
    throw new HostCapabilityError('e2e_invalid_target', 'Invalid inline visualization control')
  }
  if (!contents || contents.isDestroyed()) {
    throw new HostCapabilityError('e2e_view_unavailable', 'Verification view is unavailable')
  }
  const deadline = Date.now() + FRAME_READY_TIMEOUT_MS
  const owned = await contents.mainFrame.executeJavaScript(`(() => {
    return Array.from(document.querySelectorAll(${JSON.stringify(INLINE_FRAME_SELECTOR)}))
      .some(frame => frame.src === ${JSON.stringify(url)});
  })()`)
  if (!owned) {
    throw new HostCapabilityError(
      'e2e_frame_unavailable',
      'Inline visualization frame is not loaded'
    )
  }
  const frame = await waitForVisualizationFrame(contents, url, deadline)
  const result = await frame.executeJavaScript(`(async () => {
    if (document.readyState === 'loading') await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Inline visualization document is not ready')), ${Math.max(1, deadline - Date.now())});
      addEventListener('DOMContentLoaded', () => { clearTimeout(timeout); resolve(); }, { once: true });
    });
    const { action, selector, value } = ${JSON.stringify({ action, selector, value: value ?? '' })};
    const element = document.querySelector(selector);
    if (action === 'text') return element?.textContent ?? null;
    if (!element) throw new Error('Inline visualization target not found');
    if (action === 'metrics' || action === 'wheel') {
      const rect = element.getBoundingClientRect();
      return {
        scrollTop: element.scrollTop, scrollLeft: element.scrollLeft,
        scrollHeight: element.scrollHeight, scrollWidth: element.scrollWidth,
        clientHeight: element.clientHeight, clientWidth: element.clientWidth,
        rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
      };
    }
    if (action === 'click') element.click();
    if (action === 'fill') {
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement))
        throw new Error('Inline visualization target is not an input');
      element.value = value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (action === 'attribute') return element.getAttribute(value);
    if (action === 'value') return element.value;
    return element.textContent;
  })()`)
  if (action !== 'wheel') return result
  const input = await sendVisualizationWheel(
    contents,
    frame,
    url,
    selector,
    parseVisualizationRect(visualizationRecord(result).rect),
    deltaX as number,
    deltaY as number
  )
  return {
    ...input,
    frameProcessId: frame.processId,
    mainFrameProcessId: contents.mainFrame.processId,
  }
}

function visualizationRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HostCapabilityError('e2e_invalid_geometry', 'Invalid inline visualization geometry')
  }
  return value as Record<string, unknown>
}

function parseVisualizationRect(value: unknown): VisualizationRect {
  const { left, top, right, bottom } = visualizationRecord(value)
  if (
    typeof left !== 'number' ||
    typeof top !== 'number' ||
    typeof right !== 'number' ||
    typeof bottom !== 'number' ||
    ![left, top, right, bottom].every(Number.isFinite)
  ) {
    throw new HostCapabilityError('e2e_invalid_geometry', 'Invalid inline visualization geometry')
  }
  return { left, top, right, bottom }
}

async function sendVisualizationWheel(
  contents: VisualizationContents,
  frame: VisualizationFrame,
  url: string,
  selector: string,
  target: VisualizationRect,
  deltaX: number,
  deltaY: number
) {
  const result = await contents.mainFrame.executeJavaScript(`(() => {
    const frame = Array.from(document.querySelectorAll(${JSON.stringify(INLINE_FRAME_SELECTOR)}))
      .find(candidate => candidate.src === ${JSON.stringify(url)});
    if (!frame) throw new Error('Inline visualization frame is not loaded');
    const rect = frame.getBoundingClientRect();
    const clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    for (let ancestor = frame.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      const bounds = ancestor.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
        clip.top = Math.max(clip.top, bounds.top);
        clip.bottom = Math.min(clip.bottom, bounds.bottom);
      }
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
        clip.left = Math.max(clip.left, bounds.left);
        clip.right = Math.min(clip.right, bounds.right);
      }
    }
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, clip };
  })()`)
  const bounds = {
    ...parseVisualizationRect(result),
    clip: parseVisualizationRect(visualizationRecord(result).clip),
  }
  const left = Math.max(bounds.left + target.left, bounds.left, bounds.clip.left)
  const right = Math.min(bounds.left + target.right, bounds.right, bounds.clip.right)
  const top = Math.max(bounds.top + target.top, bounds.top, bounds.clip.top)
  const bottom = Math.min(bounds.top + target.bottom, bounds.bottom, bounds.clip.bottom)
  if (![left, right, top, bottom].every(Number.isFinite) || right <= left || bottom <= top) {
    throw new HostCapabilityError(
      'e2e_target_not_visible',
      'Inline visualization target is not visible'
    )
  }
  if (contents.isDestroyed()) {
    throw new HostCapabilityError('e2e_view_unavailable', 'Verification view is unavailable')
  }
  const x = Math.floor((left + right) / 2)
  const y = Math.floor((top + bottom) / 2)
  return withDebuggerSession(contents, async session => {
    const key = `__weworkInlineVisualizationWheel_${randomUUID()}`
    let cleanupFailure: { error: unknown } | undefined
    let probe: {
      before: VisualizationTargetObservation
      afterMove: VisualizationTargetObservation
      afterWheel: unknown
    }
    try {
      const before = parseRootObservation(
        await visualizationRootProbe(contents, key, 'start', { url, x, y })
      )
      const initial = { frameRect: parseVisualizationRect(bounds), targetRect: target }
      assertVisualizationTarget(initial, { ...before, targetRect: target }, { x, y })
      await session.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
      assertVisualizationView(contents)
      const movedTarget = await frame.executeJavaScript(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
      })()`)
      const afterMove = parseRootObservation(
        visualizationRecord(await visualizationRootProbe(contents, key, 'read')).observation
      )
      const targetRect = movedTarget === null ? null : parseVisualizationRect(movedTarget)
      assertVisualizationTarget(
        { ...before, targetRect: target },
        { ...afterMove, targetRect },
        { x, y }
      )
      assertVisualizationView(contents)
      await session.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x,
        y,
        deltaX,
        deltaY,
      })
      assertVisualizationView(contents)
      const afterWheel = await visualizationRootProbe(contents, key, 'read')
      probe = {
        before: { ...before, targetRect: target },
        afterMove: { ...afterMove, targetRect },
        afterWheel,
      }
    } finally {
      try {
        await visualizationRootProbe(contents, key, 'cleanup')
      } catch (error) {
        cleanupFailure = { error }
      }
    }
    if (cleanupFailure) throw cleanupFailure.error
    return { backend: 'chromium-input-dispatch', x, y, deltaX, deltaY, probe }
  })
}

function assertVisualizationView(contents: VisualizationContents): void {
  if (contents.isDestroyed()) {
    throw new HostCapabilityError('e2e_view_unavailable', 'Verification view is unavailable')
  }
}

function parseRootObservation(value: unknown): VisualizationRootObservation {
  const record = visualizationRecord(value)
  return {
    frameRect: record.frameRect === null ? null : parseVisualizationRect(record.frameRect),
    ownsPoint: record.ownsPoint === true,
    hit: record.hit as VisualizationRootObservation['hit'],
    hitAncestor: record.hitAncestor as VisualizationRootObservation['hitAncestor'],
  }
}

function assertVisualizationTarget(
  before: { frameRect: VisualizationRect | null; targetRect: VisualizationRect },
  after: VisualizationTargetObservation,
  point: { x: number; y: number }
): void {
  const frame = after.frameRect
  // Movement is safe only while the fixed input point still belongs to this target.
  const remainsInTarget =
    frame !== null &&
    after.targetRect !== null &&
    point.x >= frame.left + after.targetRect.left &&
    point.x < frame.left + after.targetRect.right &&
    point.y >= frame.top + after.targetRect.top &&
    point.y < frame.top + after.targetRect.bottom
  if (!after.ownsPoint || !remainsInTarget) {
    const details = { point, before, after }
    throw new HostCapabilityError(
      'e2e_target_changed',
      `Inline visualization wheel target moved or is covered: ${JSON.stringify(details)}`,
      details
    )
  }
}

async function visualizationRootProbe(
  contents: VisualizationContents,
  key: string,
  action: 'start' | 'read' | 'cleanup',
  point?: { url: string; x: number; y: number }
): Promise<unknown> {
  return contents.mainFrame.executeJavaScript(`(() => {
    const { key, action, point } = ${JSON.stringify({ key, action, point })};
    if (action === 'cleanup') {
      const probe = globalThis[key];
      if (probe) removeEventListener('wheel', probe.listener, true);
      delete globalThis[key];
      return null;
    }
    if (action === 'read') {
      const probe = globalThis[key];
      if (!probe) throw new Error('Inline visualization wheel probe is unavailable');
      return { observation: probe.observe(), wheelEvents: probe.events.slice() };
    }
    const frame = Array.from(document.querySelectorAll(${JSON.stringify(INLINE_FRAME_SELECTOR)}))
      .find(candidate => candidate.src === point.url);
    const describe = element => element instanceof Element ? {
      tag: element.tagName.toLowerCase(),
      id: element.id.slice(0, 256) || null,
      testId: element.getAttribute('data-testid')?.slice(0, 256) || null,
      className: element.getAttribute('class')?.slice(0, 256) || null,
    } : null;
    const describeAncestor = element => {
      let ancestor = element instanceof Element ? element.parentElement : null;
      for (let depth = 0; ancestor && depth < 8; depth += 1, ancestor = ancestor.parentElement) {
        if (ancestor.id || ancestor.getAttribute('data-testid')) return describe(ancestor);
      }
      return null;
    };
    const observe = () => {
      const rect = frame?.isConnected ? frame.getBoundingClientRect() : null;
      const hit = document.elementFromPoint(point.x, point.y);
      return {
        frameRect: rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } : null,
        ownsPoint: Boolean(frame?.isConnected && frame.src === point.url && hit === frame),
        hit: describe(hit),
        hitAncestor: describeAncestor(hit),
      };
    };
    const events = [];
    const listener = event => {
      if (!event.isTrusted) return;
      events.push({
        time: performance.now(), trusted: event.isTrusted,
        target: describe(event.target), targetAncestor: describeAncestor(event.target),
        clientX: event.clientX, clientY: event.clientY,
        deltaX: event.deltaX, deltaY: event.deltaY, deltaMode: event.deltaMode,
        cancelable: event.cancelable, defaultPrevented: event.defaultPrevented,
      });
      if (events.length > 8) events.shift();
    };
    globalThis[key] = { observe, events, listener };
    addEventListener('wheel', listener, { capture: true, passive: true });
    return observe();
  })()`)
}

async function waitForVisualizationFrame(
  contents: VisualizationContents,
  url: string,
  deadline: number
): Promise<VisualizationFrame> {
  while (!contents.isDestroyed()) {
    const frame = contents.mainFrame.frames.find(frame => frame.url === url)
    if (frame) return frame
    if (Date.now() >= deadline) break
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new HostCapabilityError('e2e_frame_unavailable', 'Inline visualization frame is not loaded')
}
