import { join } from 'node:path'

/** New releases own this store; legacy releases retain their independent credentials. */
export function protectedCredentialDirectory(dataDirectory: string): string {
  return join(dataDirectory, 'protected-credentials')
}
