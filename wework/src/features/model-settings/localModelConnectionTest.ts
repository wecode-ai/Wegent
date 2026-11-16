import {
  buildLocalModelRequestUrl,
  defaultLocalModelToolProfile,
  normalizeLocalModelApiFormat,
  normalizeLocalModelId,
  type LocalModelApiFormat,
  type LocalModelToolProfile,
} from './localModelSettings'
import { testModelConnection } from '../../../../packages/chat-core/src/model-connection-probe'
export type {
  ModelConnectionProbeOptions as TestLocalModelConnectionOptions,
  ModelConnectionProbeResult as TestLocalModelConnectionResult,
} from '../../../../packages/chat-core/src/model-connection-probe'
import type {
  ModelConnectionProbeOptions,
  ModelConnectionProbeResult,
} from '../../../../packages/chat-core/src/model-connection-probe'

export interface TestLocalModelConnectionInput {
  baseUrl: string
  apiFormat?: LocalModelApiFormat | null
  requestPath?: string | null
  modelId: string
  toolProfile?: LocalModelToolProfile | null
  apiKey?: string | null
}

export async function testLocalModelConnection(
  input: TestLocalModelConnectionInput,
  options: ModelConnectionProbeOptions = {}
): Promise<ModelConnectionProbeResult> {
  const apiFormat = normalizeLocalModelApiFormat(input.apiFormat)
  return testModelConnection(
    {
      requestUrl: buildLocalModelRequestUrl(input.baseUrl, input.requestPath, apiFormat),
      apiFormat,
      modelId: normalizeLocalModelId(input.modelId),
      toolProfile: input.toolProfile ?? defaultLocalModelToolProfile(apiFormat),
      apiKey: input.apiKey,
    },
    options
  )
}
