export type HttpJson = null | string | number | boolean | HttpJson[] | { [key: string]: HttpJson }

export interface ConnectionHttpOperationDefinition {
  method: 'GET' | 'POST'
  path: string
  inputSchema: Record<string, unknown>
  query?: Record<string, string | number | boolean | { $parameter: string; omitIfMissing?: true }>
  json?: HttpJson
}

export interface ConnectionHttpRequest {
  method: 'GET' | 'POST'
  path: string
  query?: Record<string, string | number | boolean>
  json?: HttpJson
}

export interface ConnectionHttp {
  read(operationId: string, parameters?: Record<string, HttpJson>): Promise<unknown>
}

export function createConnectionHttp(
  operations: Record<string, ConnectionHttpOperationDefinition>,
  request: (operation: ConnectionHttpRequest, signal?: AbortSignal) => Promise<unknown>,
  signal?: AbortSignal
): ConnectionHttp
