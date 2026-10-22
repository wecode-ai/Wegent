import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

for (const verifyAccept of [false, true]) {
  test(
    'real MCP fixture requires URL consent: ' + (verifyAccept ? 'cancel then accept' : 'cancel'),
    {
      timeout: 10_000,
    },
    async t => {
      const directory = await mkdtemp(join(tmpdir(), 'wework-mcp-consent-'))
      const evidencePath = join(directory, 'evidence.jsonl')
      const server = spawn(
        process.execPath,
        [
          fileURLToPath(new URL('../e2e/utils/mcp-elicitation-server.mjs', import.meta.url)),
          evidencePath,
          ...(verifyAccept ? ['--verify-url-accept'] : []),
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] }
      )
      const lines = createInterface({ input: server.stdout })[Symbol.asyncIterator]()
      t.after(async () => {
        server.kill()
        await rm(directory, { recursive: true, force: true })
      })
      const send = message =>
        server.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
      const receive = async () => {
        const next = await lines.next()
        assert.equal(next.done, false, 'MCP fixture exited before responding')
        return JSON.parse(next.value)
      }
      send({ id: 1, method: 'initialize', params: {} })
      assert.equal((await receive()).result.serverInfo.name, 'wework-e2e-mcp-elicitation')
      send({ id: 2, method: 'tools/list' })
      const tool = (await receive()).result.tools[0].name
      send({ id: 3, method: 'tools/call', params: { name: tool, arguments: {} } })
      const first = await receive()
      assert.equal(first.params.mode, 'url')
      await assert.rejects(stat(evidencePath), { code: 'ENOENT' })
      send({ id: first.id, result: { action: 'cancel' } })
      let next = await receive()
      const records = async () =>
        (await readFile(evidencePath, 'utf8'))
          .trim()
          .split('\n')
          .map(line => JSON.parse(line))
      assert.deepEqual(await records(), [
        { event: 'url_elicitation_result', result: { action: 'cancel' } },
      ])
      if (verifyAccept) {
        assert.equal(next.params.mode, 'url')
        assert.notEqual(next.id, first.id)
        send({ id: next.id, result: { action: 'accept' } })
        next = await receive()
        assert.deepEqual(await records(), [
          { event: 'url_elicitation_result', result: { action: 'cancel' } },
          { event: 'url_elicitation_result', result: { action: 'accept' } },
        ])
      }
      assert.equal(next.params.mode, 'form')
      send({ id: next.id, result: { action: 'accept', content: { audience: 'owner' } } })
      const complete = await receive()
      assert.equal(complete.id, 3)
      assert.equal(complete.result.isError, false)
      assert.equal(complete.result.structuredContent.marker, 'E2E_MCP_ELICITATION_ACCEPTED:owner')
      assert.equal(
        (await records()).length,
        verifyAccept ? 3 : 2,
        'Fixture recorded duplicate consent'
      )
    }
  )
}
