import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { WebContents } from 'electron'

export type BrowserRecordingStepType =
  | 'navigate'
  | 'click'
  | 'fill'
  | 'select'
  | 'key'
  | 'scroll'
  | 'handoff'

export interface BrowserRecordingTarget {
  selector: string | null
  role: string | null
  name: string | null
}

export interface BrowserRecordingStep {
  id: string
  type: BrowserRecordingStepType
  offsetMs: number
  url?: string
  target?: BrowserRecordingTarget
  value?: string
  key?: string
  x?: number
  y?: number
  risk: 'low' | 'high'
  replayable: boolean
  reason?: string
}

export interface BrowserRecording {
  id: string
  title: string
  browserLabel: string
  createdAt: number
  endedAt: number
  initialUrl: string | null
  steps: BrowserRecordingStep[]
}

export interface BrowserRecordingSummary {
  id: string
  title: string
  browserLabel: string
  createdAt: number
  endedAt: number
  initialUrl: string | null
  stepCount: number
  durationMs: number
  containsHandoff: boolean
}

export interface BrowserRecordingStatus {
  phase: 'idle' | 'recording' | 'replaying' | 'paused' | 'failed'
  recordingId: string | null
  browserLabel: string | null
  title: string | null
  stepCount: number
  currentStep: number | null
  message: string | null
}

interface CapturedBrowserEvent {
  type: 'click' | 'fill' | 'select' | 'key' | 'scroll'
  timestamp: number
  target?: BrowserRecordingTarget
  value?: string
  key?: string
  x?: number
  y?: number
}

interface ActiveRecording {
  id: string
  title: string
  browserLabel: string
  startedAt: number
  initialUrl: string | null
  steps: BrowserRecordingStep[]
  drainTimer: NodeJS.Timeout
}

interface ActiveReplay {
  recordingId: string
  browserLabel: string
  currentStep: number
  cancelled: boolean
}

interface BrowserRecordingFile {
  version: 1
  recordings: BrowserRecording[]
}

const CAPTURE_POLL_INTERVAL_MS = 250
const MAX_REPLAY_DELAY_MS = 1_500
const MAX_RECORDINGS = 100
const SENSITIVE_VALUE_PATTERN =
  /(?:password|passcode|secret|token|api.?key|credit|card|cvv|cvc|phone|email|身份证|密码|令牌|手机号|邮箱)/i
const SENSITIVE_CONTENT_PATTERN =
  /(?:[^\s@]+@[^\s@]+\.[^\s@]+|\+?\d[\d\s()-]{8,}|(?:\d[ -]?){13,19})/
const HIGH_RISK_ACTION_PATTERN =
  /(?:delete|remove|destroy|purchase|buy|pay|checkout|submit order|confirm order|删除|移除|支付|购买|下单|提交订单)/i

export class BrowserRecordReplay {
  private readonly storagePath: string
  private activeRecording: ActiveRecording | null = null
  private activeReplay: ActiveReplay | null = null
  private statusValue: BrowserRecordingStatus = idleStatus()

  constructor(
    dataDirectory: string,
    private readonly resolveContents: (label: string) => WebContents | null,
    private readonly navigate: (label: string, url: string) => Promise<void>
  ) {
    this.storagePath = join(dataDirectory, 'browser-recordings', 'recordings.json')
  }

  status(): BrowserRecordingStatus {
    return { ...this.statusValue }
  }

  async list(): Promise<BrowserRecordingSummary[]> {
    const file = await this.readFile()
    return file.recordings
      .map(recording => ({
        id: recording.id,
        title: recording.title,
        browserLabel: recording.browserLabel,
        createdAt: recording.createdAt,
        endedAt: recording.endedAt,
        initialUrl: recording.initialUrl,
        stepCount: recording.steps.length,
        durationMs: Math.max(0, recording.endedAt - recording.createdAt),
        containsHandoff: recording.steps.some(step => step.type === 'handoff'),
      }))
      .sort((left, right) => right.createdAt - left.createdAt)
  }

  async get(id: string): Promise<BrowserRecording | null> {
    const file = await this.readFile()
    return file.recordings.find(recording => recording.id === id) ?? null
  }

  async start(title: string, browserLabel: string): Promise<BrowserRecordingStatus> {
    if (this.activeRecording || this.activeReplay) {
      throw new Error('Record and replay is already active')
    }
    const normalizedTitle = title.trim() || 'Untitled recording'
    const startedAt = Date.now()
    const contents = this.resolveContents(browserLabel)
    const initialUrl = contents?.getURL() || null
    const id = randomUUID()
    const active: ActiveRecording = {
      id,
      title: normalizedTitle,
      browserLabel,
      startedAt,
      initialUrl,
      steps: [],
      drainTimer: setInterval(() => void this.drainActiveRecording(), CAPTURE_POLL_INTERVAL_MS),
    }
    this.activeRecording = active
    if (initialUrl) this.appendNavigation(initialUrl, false)
    if (contents) await this.installCapture(contents)
    this.statusValue = {
      phase: 'recording',
      recordingId: id,
      browserLabel,
      title: normalizedTitle,
      stepCount: active.steps.length,
      currentStep: null,
      message: contents ? null : 'Waiting for the Wework built-in browser to open',
    }
    return this.status()
  }

  async stop(): Promise<BrowserRecording> {
    const active = this.activeRecording
    if (!active) throw new Error('No browser recording is active')
    clearInterval(active.drainTimer)
    await this.drainActiveRecording()
    this.activeRecording = null
    const recording: BrowserRecording = {
      id: active.id,
      title: active.title,
      browserLabel: active.browserLabel,
      createdAt: active.startedAt,
      endedAt: Date.now(),
      initialUrl: active.initialUrl,
      steps: active.steps,
    }
    await this.mutate(recordings => [
      recording,
      ...recordings.filter(item => item.id !== recording.id),
    ])
    this.statusValue = idleStatus()
    return recording
  }

  async remove(id: string): Promise<boolean> {
    let removed = false
    await this.mutate(recordings =>
      recordings.filter(recording => {
        if (recording.id !== id) return true
        removed = true
        return false
      })
    )
    return removed
  }

  async replay(id: string, browserLabel: string): Promise<BrowserRecordingStatus> {
    if (this.activeRecording || this.activeReplay) {
      throw new Error('Record and replay is already active')
    }
    const recording = await this.get(id)
    if (!recording) throw new Error('Browser recording not found')
    if (!this.resolveContents(browserLabel)) {
      throw new Error('Open the Wework built-in browser before replaying')
    }
    const replay: ActiveReplay = {
      recordingId: id,
      browserLabel,
      currentStep: 0,
      cancelled: false,
    }
    this.activeReplay = replay
    this.statusValue = {
      phase: 'replaying',
      recordingId: id,
      browserLabel,
      title: recording.title,
      stepCount: recording.steps.length,
      currentStep: 0,
      message: null,
    }
    void this.runReplay(recording, replay)
    return this.status()
  }

  cancel(): void {
    if (this.activeReplay) this.activeReplay.cancelled = true
    if (this.statusValue.phase === 'paused' || this.statusValue.phase === 'failed') {
      this.statusValue = idleStatus()
    }
  }

  async browserReady(label: string, contents: WebContents): Promise<void> {
    if (this.activeRecording?.browserLabel !== label) return
    await this.installCapture(contents)
    this.statusValue = { ...this.statusValue, message: null }
  }

  recordNavigation(label: string, url: string, inPage: boolean): void {
    if (this.activeRecording?.browserLabel !== label) return
    this.appendNavigation(url, inPage)
  }

  private appendNavigation(url: string, inPage: boolean): void {
    const active = this.activeRecording
    if (!active || !url) return
    const previous = active.steps.at(-1)
    if (previous?.type === 'navigate' && previous.url === url) return
    active.steps.push({
      id: randomUUID(),
      type: 'navigate',
      offsetMs: Date.now() - active.startedAt,
      url,
      risk: 'low',
      replayable: true,
      ...(inPage ? { reason: 'In-page navigation' } : {}),
    })
    this.refreshRecordingStatus()
  }

  private async drainActiveRecording(): Promise<void> {
    const active = this.activeRecording
    if (!active) return
    const contents = this.resolveContents(active.browserLabel)
    if (!contents || contents.isDestroyed()) return
    let events: CapturedBrowserEvent[]
    try {
      const value = await contents.executeJavaScript(
        'window.__WEWORK_RECORD_REPLAY__?.drain?.() ?? []',
        true
      )
      events = Array.isArray(value) ? (value as CapturedBrowserEvent[]) : []
    } catch {
      return
    }
    for (const event of events) {
      const step = normalizeCapturedEvent(event, active.startedAt)
      if (!step) continue
      active.steps.push(step)
      if (step.risk === 'high') {
        active.steps.push({
          id: randomUUID(),
          type: 'handoff',
          offsetMs: step.offsetMs,
          risk: 'high',
          replayable: false,
          reason: 'Replay requires confirmation before this high-risk action',
        })
      }
    }
    this.refreshRecordingStatus()
  }

  private refreshRecordingStatus(): void {
    if (!this.activeRecording) return
    this.statusValue = {
      ...this.statusValue,
      stepCount: this.activeRecording.steps.length,
    }
  }

  private async installCapture(contents: WebContents): Promise<void> {
    if (contents.isDestroyed()) return
    await contents.executeJavaScript(CAPTURE_SCRIPT, true).catch(() => undefined)
  }

  private async runReplay(recording: BrowserRecording, replay: ActiveReplay): Promise<void> {
    try {
      let previousOffset = 0
      for (let index = 0; index < recording.steps.length; index += 1) {
        if (replay.cancelled) {
          this.statusValue = idleStatus()
          return
        }
        const step = recording.steps[index]
        replay.currentStep = index
        this.statusValue = { ...this.statusValue, currentStep: index }
        if (!step.replayable || step.type === 'handoff') {
          this.statusValue = {
            ...this.statusValue,
            phase: 'paused',
            message: step.reason ?? 'Replay paused for manual confirmation',
          }
          return
        }
        const delay = Math.min(MAX_REPLAY_DELAY_MS, Math.max(0, step.offsetMs - previousOffset))
        previousOffset = step.offsetMs
        if (delay > 0) await wait(delay)
        await this.replayStep(replay.browserLabel, step)
      }
      this.statusValue = idleStatus()
    } catch (error) {
      this.statusValue = {
        ...this.statusValue,
        phase: 'failed',
        message: error instanceof Error ? error.message : String(error),
      }
    } finally {
      this.activeReplay = null
    }
  }

  private async replayStep(label: string, step: BrowserRecordingStep): Promise<void> {
    if (step.type === 'navigate') {
      if (step.url) await this.navigate(label, step.url)
      return
    }
    const contents = this.resolveContents(label)
    if (!contents || contents.isDestroyed()) throw new Error('Wework built-in browser was closed')
    const result = await contents.executeJavaScript(replayExpression(step), true)
    if (result !== true) {
      throw new Error(
        typeof result === 'string' ? result : `Replay target was not found for ${step.type}`
      )
    }
  }

  private async readFile(): Promise<BrowserRecordingFile> {
    try {
      const parsed = JSON.parse(await readFile(this.storagePath, 'utf8')) as BrowserRecordingFile
      return parsed.version === 1 && Array.isArray(parsed.recordings)
        ? parsed
        : { version: 1, recordings: [] }
    } catch {
      return { version: 1, recordings: [] }
    }
  }

  private async mutate(
    update: (recordings: BrowserRecording[]) => BrowserRecording[]
  ): Promise<void> {
    const file = await this.readFile()
    const recordings = update(file.recordings).slice(0, MAX_RECORDINGS)
    await mkdir(dirname(this.storagePath), { recursive: true, mode: 0o700 })
    const temporary = `${this.storagePath}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify({ version: 1, recordings }, null, 2)}\n`, {
      mode: 0o600,
    })
    await rename(temporary, this.storagePath)
  }
}

function normalizeCapturedEvent(
  event: CapturedBrowserEvent,
  startedAt: number
): BrowserRecordingStep | null {
  if (!event || !['click', 'fill', 'select', 'key', 'scroll'].includes(event.type)) return null
  const name = `${event.target?.name ?? ''} ${event.target?.role ?? ''}`
  const sensitive =
    SENSITIVE_VALUE_PATTERN.test(name) ||
    (event.value !== undefined && SENSITIVE_CONTENT_PATTERN.test(event.value))
  const highRisk = event.type === 'click' && HIGH_RISK_ACTION_PATTERN.test(name)
  return {
    id: randomUUID(),
    type: event.type,
    offsetMs: Math.max(0, event.timestamp - startedAt),
    ...(event.target ? { target: event.target } : {}),
    ...(event.value !== undefined
      ? { value: sensitive ? '{{USER_INPUT_REQUIRED}}' : event.value }
      : {}),
    ...(event.key ? { key: event.key } : {}),
    ...(typeof event.x === 'number' ? { x: event.x } : {}),
    ...(typeof event.y === 'number' ? { y: event.y } : {}),
    risk: highRisk ? 'high' : 'low',
    replayable: !sensitive && !highRisk,
    ...(sensitive ? { reason: 'Sensitive value was not stored' } : {}),
  }
}

function replayExpression(step: BrowserRecordingStep): string {
  return `(() => {
    const step = ${JSON.stringify(step)};
    const target = step.target?.selector ? document.querySelector(step.target.selector) : null;
    if (step.type === 'scroll') {
      window.scrollTo({ left: step.x ?? 0, top: step.y ?? 0, behavior: 'instant' });
      return true;
    }
    if (!(target instanceof HTMLElement)) return 'Replay target is unavailable';
    target.scrollIntoView({ block: 'center', inline: 'center' });
    if (step.type === 'click') {
      target.click();
      return true;
    }
    if (step.type === 'fill') {
      if (!('value' in target)) return 'Replay target does not accept text';
      const prototype = target instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      setter?.call(target, step.value ?? '');
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    if (step.type === 'select') {
      if (!(target instanceof HTMLSelectElement)) return 'Replay target is not a select';
      target.value = step.value ?? '';
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    if (step.type === 'key') {
      target.focus();
      target.dispatchEvent(new KeyboardEvent('keydown', { key: step.key ?? '', bubbles: true }));
      target.dispatchEvent(new KeyboardEvent('keyup', { key: step.key ?? '', bubbles: true }));
      return true;
    }
    return false;
  })()`
}

function idleStatus(): BrowserRecordingStatus {
  return {
    phase: 'idle',
    recordingId: null,
    browserLabel: null,
    title: null,
    stepCount: 0,
    currentStep: null,
    message: null,
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

const CAPTURE_SCRIPT = `(() => {
  if (window.__WEWORK_RECORD_REPLAY__) return true;
  const queue = [];
  const lastValues = new WeakMap();
  const cssEscape = value => globalThis.CSS?.escape ? CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, '\\\\$&');
  const selectorFor = element => {
    if (!(element instanceof Element)) return null;
    const testId = element.getAttribute('data-testid');
    if (testId) return '[data-testid="' + cssEscape(testId) + '"]';
    if (element.id) return '#' + cssEscape(element.id);
    const name = element.getAttribute('name');
    if (name) return element.tagName.toLowerCase() + '[name="' + cssEscape(name) + '"]';
    const aria = element.getAttribute('aria-label');
    if (aria) return element.tagName.toLowerCase() + '[aria-label="' + cssEscape(aria) + '"]';
    const parts = [];
    let current = element;
    while (current && current !== document.body && parts.length < 5) {
      let part = current.tagName.toLowerCase();
      const parent = current.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter(child => child.tagName === current.tagName);
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.join(' > ');
  };
  const targetFor = element => {
    if (!(element instanceof Element)) return undefined;
    const interactive = element.closest('button, a, input, textarea, select, [role="button"], [role="link"], [role="textbox"], [role="option"]') || element;
    const label = interactive.getAttribute('aria-label')
      || interactive.getAttribute('placeholder')
      || interactive.textContent?.trim().slice(0, 100)
      || interactive.getAttribute('name')
      || '';
    return {
      selector: selectorFor(interactive),
      role: interactive.getAttribute('role') || interactive.tagName.toLowerCase(),
      name: label,
    };
  };
  const sensitive = element => {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return false;
    return element.type === 'password'
      || element.type === 'hidden'
      || /^cc-/i.test(element.autocomplete)
      || /password|secret|token|card|cvv|cvc/i.test(element.name + ' ' + element.id + ' ' + element.placeholder);
  };
  const pushValue = element => {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return;
    const value = sensitive(element) ? '{{USER_INPUT_REQUIRED}}' : element.value;
    if (lastValues.get(element) === value) return;
    lastValues.set(element, value);
    queue.push({ type: 'fill', timestamp: Date.now(), target: targetFor(element), value });
  };
  document.addEventListener('click', event => {
    const element = event.target instanceof Element ? event.target : null;
    if (element) queue.push({ type: 'click', timestamp: Date.now(), target: targetFor(element) });
  }, true);
  document.addEventListener('change', event => {
    const element = event.target;
    if (element instanceof HTMLSelectElement) {
      queue.push({ type: 'select', timestamp: Date.now(), target: targetFor(element), value: element.value });
    } else {
      pushValue(element);
    }
  }, true);
  document.addEventListener('focusout', event => pushValue(event.target), true);
  document.addEventListener('keydown', event => {
    if (!['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    queue.push({ type: 'key', timestamp: Date.now(), target: targetFor(event.target), key: event.key });
  }, true);
  let scrollTimer = null;
  window.addEventListener('scroll', () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => queue.push({
      type: 'scroll',
      timestamp: Date.now(),
      x: window.scrollX,
      y: window.scrollY,
    }), 120);
  }, true);
  window.__WEWORK_RECORD_REPLAY__ = {
    drain() {
      return queue.splice(0, queue.length);
    },
  };
  return true;
})()`
