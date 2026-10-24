import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, test } from 'vitest'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function runProbe() {
  const root = mkdtempSync(join(tmpdir(), 'wework-mcp-identity-'))
  roots.push(root)
  const evidencePath = join(root, 'probe.json')
  const input = [
    { id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    { id: 2, method: 'tools/call', params: { name: 'probe_environment' } },
    { id: 3, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    { id: 4, method: 'tools/call', params: { name: 'probe_environment' } },
  ]
  const child = spawnSync(
    process.execPath,
    [
      resolve(import.meta.dirname, '../../e2e/desktop/modules/native-mcp-environment.mjs'),
      '--stdio-env-server',
      'first',
      evidencePath,
      'probe_environment',
    ],
    {
      input: input.map(message => JSON.stringify(message) + '\n').join(''),
      encoding: 'utf8',
      timeout: 3000,
      env: { ...process.env, TOKEN: 'synthetic-context', OPENAI_API_KEY: 'synthetic-key' },
    }
  )
  expect(child.error).toBeUndefined()
  expect(child.status, child.stderr).toBe(0)
  const replies = child.stdout
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as {
    instanceId: string
    pid: number
  }
  return { replies, evidence }
}

test('MCP identity belongs to the process lifetime and is returned by its real tool', () => {
  const first = runProbe()
  const second = runProbe()

  for (const { replies, evidence } of [first, second]) {
    expect(evidence.instanceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
    const calls = replies.filter(reply => [2, 4].includes(reply.id))
    expect(calls).toHaveLength(2)
    expect(calls[0].result).toEqual(calls[1].result)
    expect(JSON.stringify(calls[0].result)).toContain(`MCP_INSTANCE:${evidence.instanceId}`)
    expect(JSON.stringify(calls[0].result)).toContain('MCP_CONTEXT:synthetic-context')
  }
  expect(second.evidence.instanceId).not.toBe(first.evidence.instanceId)
})
