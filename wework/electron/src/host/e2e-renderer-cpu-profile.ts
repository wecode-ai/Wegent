import type { WebContents } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

type CpuProfile = {
  nodes: Array<{ callFrame: { url: string } }>
}

export function installE2ERendererCpuProfile(
  contents: WebContents,
  directory: string,
  environment: NodeJS.ProcessEnv = process.env
): () => void {
  if (
    environment.VITE_WEWORK_E2E !== 'true' ||
    environment.WEWORK_E2E_RENDERER_CPU_PROFILE !== 'true'
  )
    return () => {}
  const recorder = new RendererCpuRecorder(contents, directory)
  contents.once('did-finish-load', recorder.start)
  contents.once('destroyed', recorder.dispose)
  return recorder.dispose
}

class RendererCpuRecorder {
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private attached = false
  private sequence = 0

  constructor(
    private contents: WebContents,
    private directory: string
  ) {}

  readonly start = () => {
    void this.begin().catch(this.fail)
  }

  private async begin() {
    if (this.contents.debugger.isAttached())
      throw new Error('Renderer debugger is already attached')
    this.contents.debugger.attach('1.3')
    this.attached = true
    await this.contents.debugger.sendCommand('Profiler.enable')
    await this.contents.debugger.sendCommand('Profiler.setSamplingInterval', { interval: 5000 })
    await this.resume()
  }

  private async resume() {
    if (this.stopped) return
    await this.contents.debugger.sendCommand('Profiler.start')
    if (!this.stopped) {
      this.timer = setTimeout(() => void this.sample().catch(this.fail), 5000)
    }
  }

  private async sample() {
    if (this.stopped) return
    const result = (await this.contents.debugger.sendCommand('Profiler.stop')) as {
      profile: CpuProfile
    }
    for (const node of result.profile.nodes) {
      const url = node.callFrame.url
      if (!url) continue
      if (URL.canParse(url)) {
        const parsed = new URL(url)
        parsed.username = ''
        parsed.password = ''
        parsed.search = ''
        parsed.hash = ''
        node.callFrame.url = parsed.href
      } else {
        node.callFrame.url = url.split(/[?#]/, 1)[0]
      }
    }
    await mkdir(this.directory, { recursive: true })
    const file = `e2e-renderer-${this.contents.id}-${++this.sequence}.cpuprofile`
    await writeFile(join(this.directory, file), JSON.stringify(result.profile))
    await this.resume()
  }

  private readonly fail = (error: unknown) => {
    console.warn(
      '[Wework] Renderer CPU diagnostic failed:',
      error instanceof Error ? error.message : String(error)
    )
    this.dispose()
  }

  readonly dispose = () => {
    this.stopped = true
    if (this.timer !== null) clearTimeout(this.timer)
    this.contents.removeListener('did-finish-load', this.start)
    this.contents.removeListener('destroyed', this.dispose)
    try {
      if (this.attached && !this.contents.isDestroyed()) this.contents.debugger.detach()
    } catch {
      // Diagnostic cleanup must not replace the original scenario failure.
    }
    this.attached = false
  }
}
