import {
  buildLocalModelRequestUrl,
  normalizeLocalModelApiFormat,
  type LocalModelApiFormat,
  type LocalModelToolProfile,
} from './localModelSettings'

import { probeModelConnection } from '../../../electron/src/shared/model-connection-probe'

export interface TestLocalModelConnectionInput {
  baseUrl: string
  apiFormat?: LocalModelApiFormat | null
  requestPath?: string | null
  modelId: string
  toolProfile?: LocalModelToolProfile | null
  apiKey?: string | null
}

export interface TestLocalModelConnectionOptions {
  fetcher?: typeof fetch
  timeoutMs?: number
  verifyExactProbePayload?: boolean
}

export interface TestLocalModelConnectionResult {
  status: number
  toolCalling: true
}

export function testLocalModelConnection(
  input: TestLocalModelConnectionInput,
  options: TestLocalModelConnectionOptions = {}
): Promise<TestLocalModelConnectionResult> {
  const apiFormat = normalizeLocalModelApiFormat(input.apiFormat)
  return probeModelConnection(
    {
      ...input,
      apiFormat,
      requestUrl: buildLocalModelRequestUrl(input.baseUrl, input.requestPath, apiFormat),
    },
    options
  )
}
