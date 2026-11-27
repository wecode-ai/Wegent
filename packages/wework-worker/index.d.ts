export interface Task {
  readonly invocationId: string
  readonly projectId: string
  readonly issueId: string
  readonly input: string
}

export interface Reply {
  readonly signal: AbortSignal
  progress(text: string): Promise<void>
  append(text: string): Promise<void>
}

export interface Worker {
  onTask(
    handler: (
      task: Task,
      reply: Reply,
    ) => void | string | Promise<void | string>,
  ): void
  start(): Promise<void>
  stop(): void
}

export function createWorker(options: {
  endpoint: string
  token: string
  path?: string
  onError?: (error: unknown) => void
}): Worker
