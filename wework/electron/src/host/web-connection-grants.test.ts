import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { WebConnectionGrants, type WebConnectionScope } from './web-connection-grants.js'

test('an approval follows the exact successful web package across a host restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-web-grants-'))
  try {
    const definition = '{}'
    const binding = {
      providerId: 'wework-web-agent-runs/web',
      definitionDigest: createHash('sha256').update(definition).digest('hex'),
    }
    const scope: WebConnectionScope = {
      origin: 'https://analytics.example.test',
      pathPrefix: '/project/12',
      name: 'Agent runs',
      account: 'alice',
      operations: [{ method: 'GET', path: '/project/12/results' }],
    }
    const request = vi.fn(async () => ({ rows: [] }))
    const confirm = vi.fn(async () => true)
    const page = () => scope.origin + '/project/12/report'
    const host = new WebConnectionGrants(root, page, confirm, request)
    const operation = scope.operations[0]
    await expect(host.read(binding, operation)).rejects.toMatchObject({
      code: 'web_connection_denied',
    })
    const trial = await host.approveTrial('browser-tab', binding, scope)
    await expect(
      host.read(binding, { ...operation, path: '/project/13/results' }, trial)
    ).rejects.toMatchObject({ code: 'web_connection_denied' })
    expect(request).not.toHaveBeenCalled()
    await expect(host.read(binding, operation, trial)).resolves.toEqual({ rows: [] })

    const files = {
      'package.json': '{"name":"wework-web-agent-runs"}',
      'index.js': '',
      'cordis.patch.yml': '',
      'connection.json': definition,
    }
    const cancel = vi.fn(async () => {
      throw new Error('Cancelled')
    })
    await expect(host.install(binding, trial, files, cancel)).rejects.toThrow('Cancelled')
    await expect(host.read(binding, operation)).rejects.toMatchObject({
      code: 'web_connection_denied',
    })
    await expect(
      host.install(binding, trial, { ...files, 'connection.json': '{"different":true}' }, cancel)
    ).rejects.toMatchObject({ code: 'web_connection_denied' })
    await host.install(binding, trial, files, async spec => {
      expect(spec).toMatch(/^file:/)
      expect(await readFile(join(spec.slice(5), 'connection.json'), 'utf8')).toBe(definition)
    })
    await expect(host.install(binding, trial, files, cancel)).rejects.toMatchObject({
      code: 'web_connection_trial_required',
    })
    const restarted = new WebConnectionGrants(root, () => null, confirm, request)
    await expect(restarted.read(binding, operation)).resolves.toEqual({ rows: [] })
    await expect(
      restarted.read({ ...binding, definitionDigest: 'a'.repeat(64) }, operation)
    ).rejects.toMatchObject({ code: 'web_connection_denied' })
    expect(confirm).toHaveBeenCalledOnce()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
