import { readFile } from 'node:fs/promises'

export class LocalJsonReadError extends Error {
  constructor(
    readonly path: string,
    readonly code: string
  ) {
    super(`Cannot read ${path} (${code})`)
  }
}

export async function readLocalJson<T>(
  path: string,
  validate: (value: unknown, path: string) => value is T
): Promise<T | null> {
  let content: string
  try {
    content = await readFile(path, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    throw new LocalJsonReadError(path, code ?? 'READ_FAILED')
  }
  return parseLocalJson(path, content, validate)
}

export function parseLocalJson<T>(
  path: string,
  content: string,
  validate: (value: unknown, path: string) => value is T
): T {
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch {
    throw new LocalJsonReadError(path, 'INVALID_JSON')
  }
  if (!validate(value, path)) throw new LocalJsonReadError(path, 'INVALID_DATA')
  return value
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
