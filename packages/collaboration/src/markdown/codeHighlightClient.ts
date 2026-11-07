import type { HighlightedCode } from './highlightCode'

interface PendingHighlight {
  resolve: (result: HighlightedCode) => void
  reject: (error: Error) => void
}

/** One lazy worker per renderer. The owner releases it when the last code block unmounts. */
export class CodeHighlightClient {
  private worker: Worker | null = null
  private nextId = 0
  private pending = new Map<number, PendingHighlight>()
  private consumers = 0

  retain(): () => void {
    this.consumers += 1
    return () => {
      this.consumers -= 1
      if (this.consumers === 0) this.dispose()
    }
  }

  private readonly createWorker: () => Worker

  constructor(
    createWorker = () =>
      new Worker(new URL('./highlightCode.worker.ts', import.meta.url), {
        type: 'module',
      })
  ) {
    this.createWorker = createWorker
  }

  async highlight(code: string, language: string): Promise<HighlightedCode> {
    if (!this.worker) {
      this.worker = this.createWorker()
      this.worker.onmessage = ({
        data,
      }: MessageEvent<{
        id: number
        result?: HighlightedCode
        error?: string
      }>) => {
        const request = this.pending.get(data.id)
        if (!request) return
        this.pending.delete(data.id)
        if (data.result) request.resolve(data.result)
        else request.reject(new Error(data.error ?? 'Code highlighting failed'))
      }
      this.worker.onerror = () => this.dispose(new Error('Code highlighting worker failed'))
    }
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.worker!.postMessage({ id, code, language })
    })
  }

  dispose(error = new Error('Code highlighting disposed')): void {
    this.worker?.terminate()
    this.worker = null
    for (const request of this.pending.values()) request.reject(error)
    this.pending.clear()
  }
}

export const codeHighlightClient = new CodeHighlightClient()
