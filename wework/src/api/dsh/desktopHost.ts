export interface DesktopHostErrorPayload {
  code: string
  message: string
  details?: Record<string, unknown>
}

export class DesktopHostError extends Error {
  readonly code: string
  readonly details: Record<string, unknown>

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'DesktopHostError'
    this.code = code
    this.details = details
  }
}

export async function invokeDesktopHost<Result>(
  capability: string,
  params: Record<string, unknown> = {}
): Promise<Result> {
  const response = await fetch('/wework/electron-host/v1/invoke', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ capability, params }),
  })
  const body = (await response.json()) as {
    ok?: boolean
    result?: Result
    error?: DesktopHostErrorPayload
  }
  if (!response.ok || body.ok !== true) {
    throw new DesktopHostError(
      body.error?.code ?? `http_${response.status}`,
      body.error?.message ?? `Electron host request failed with HTTP ${response.status}`,
      body.error?.details
    )
  }
  return body.result as Result
}
