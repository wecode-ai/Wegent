import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { SecureValueStore } from './secure-value-store.js'

const LOCAL_MODELS = 'wework.localModelSettings.v1'
const CLOUD = 'wework.cloudConnection'

/** Protect legacy mirrors before the caller durably replaces their plaintext copies. */
export class CredentialMirrorMigration {
  constructor(private readonly secrets: Pick<SecureValueStore, 'update'>) {}

  /** Preserve exact damaged bytes privately before a caller removes a weak copy. */
  async archive(name: string, content: Buffer | string): Promise<void> {
    const bytes = Buffer.from(content)
    const key = `wework-mirrors.recovery.${createHash('sha256').update(name).update('\0').update(bytes).digest('hex')}`
    await this.secrets.update(values => {
      values[key] = JSON.stringify({ name, base64: bytes.toString('base64') })
    })
  }

  async cleanArtifacts(directory: string): Promise<void> {
    for (const name of await readdir(directory)) {
      if (
        !/^(?:app-preferences|renderer-local-storage|cloud-credentials)\.json(?:\.corrupt-[0-9]+|\.[a-zA-Z0-9.-]+\.tmp)$/.test(
          name
        )
      )
        continue
      const path = join(directory, name)
      if (!(await lstat(path)).isFile())
        throw new Error('Credential migration artifact is not a regular file')
      await this.archive(name, await readFile(path))
      await rm(path)
    }
  }

  async renderer(input: Record<string, string>): Promise<Record<string, string>> {
    const entries = { ...input }
    await this.secrets.update(values => {
      if (entries[LOCAL_MODELS] !== undefined) {
        if (!values['wework-mirrors.models']) {
          values['wework-models.legacy'] = entries[LOCAL_MODELS]
          values['wework-mirrors.models'] = '3'
        }
        delete entries[LOCAL_MODELS]
      }
      if (entries[CLOUD])
        entries[CLOUD] = JSON.stringify(this.cloud(JSON.parse(entries[CLOUD]), 'renderer', values))
    })
    return entries
  }

  async preferences(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = structuredClone(input)
    await this.secrets.update(values => {
      if (result.cloudConnection)
        result.cloudConnection = this.cloud(result.cloudConnection, 'preferences', values)
    })
    return result
  }

  private cloud(input: unknown, source: string, values: Record<string, string>): unknown {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return input
    const result = { ...input } as Record<string, unknown>
    const marker = `wework-mirrors.cloud-${source}`
    if (
      !values[marker] &&
      !values['wework-cloud.mirrors-closed'] &&
      typeof result.token === 'string' &&
      result.token
    ) {
      if (typeof result.apiBaseUrl !== 'string')
        throw new Error('Legacy cloud connection has no endpoint')
      const url = new URL(result.apiBaseUrl)
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error('Invalid legacy cloud endpoint')
      const legacy = JSON.stringify({
        apiBaseUrl: url.href.replace(/\/+$/, ''),
        accessToken: result.token,
      })
      if (!values['wework-cloud.identity'] && !values['wework-cloud.legacy'])
        values['wework-cloud.legacy'] = legacy
      else if (values['wework-cloud.legacy'] !== legacy) {
        // Preserve conflicting sources in the vault without replacing the selected identity.
        values[`wework-mirrors.conflict.${createHash('sha256').update(legacy).digest('hex')}`] =
          legacy
      }
      values[marker] = '3'
    }
    delete result.token
    delete result.tokenExpiresAt
    return result
  }
}
