import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

for (const action of ['accept', 'cancel']) {
  test(
    `concurrent MCP keeps tools/call open until gated elicitation receives ${action}`,
    {
      timeout: 10_000,
    },
    async t => {
      const directory = await mkdtemp(join(tmpdir(), 'wework-mcp-concurrent-'))
      const evidencePath = join(directory, 'evidence.jsonl')
      const scenario = `concurrent_${action}`
      const server = spawn(
        process.execPath,
        [
          fileURLToPath(new URL('../e2e/utils/mcp-elicitation-server.mjs', import.meta.url)),
          evidencePath,
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] }
      )
      t.after(async () => {
        server.kill()
        await rm(directory, { recursive: true, force: true })
      })
      const lines = createInterface({ input: server.stdout })[Symbol.asyncIterator]()
      const send = message =>
        server.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
      const receive = async () => {
        const next = await lines.next()
        assert.equal(next.done, false)
        return JSON.parse(next.value)
      }
      send({
        id: 1,
        method: 'tools/call',
        params: {
          name: 'confirm_inner_site_access',
          arguments: { scenario },
        },
      })
      // An unrelated request is serviced while the original tools/call is held.
      send({ id: 2, method: 'tools/list' })
      assert.equal((await receive()).id, 2)
      await assert.rejects(stat(`${evidencePath}.concurrent`), { code: 'ENOENT' })
      await writeFile(`${evidencePath}.concurrent.${scenario}.ready`, 'ready')
      const elicitation = await receive()
      assert.equal(elicitation.method, 'elicitation/create')
      assert.equal(elicitation.params.mode, 'form')
      const result = action === 'accept' ? { action, content: { audience: 'owner' } } : { action }
      send({ id: elicitation.id, result })
      const completed = await receive()
      assert.equal(completed.id, 1)
      assert.equal(
        completed.result.structuredContent.marker,
        `E2E_MCP_ELICITATION_CONCURRENT:${scenario}:${action}`
      )
      const records = (await readFile(`${evidencePath}.concurrent`, 'utf8'))
        .trim()
        .split('\n')
        .map(JSON.parse)
      assert.deepEqual(
        records.map(record => record.event),
        ['concurrent_elicitation_request', 'concurrent_elicitation_result']
      )
      assert.deepEqual(records[1].result, result)
      await assert.rejects(stat(evidencePath), { code: 'ENOENT' })
    }
  )
}

for (const scenario of ['url_timeout', 'form_timeout']) {
  test(
    `MCP timeout evidence uses elapsed time across wall-clock corrections: ${scenario}`,
    {
      timeout: 10_000,
    },
    async t => {
      const directory = await mkdtemp(join(tmpdir(), 'wework-mcp-clock-'))
      const evidencePath = join(directory, 'evidence.jsonl')
      // Only this protocol unit test changes the wall clock; desktop E2E uses real clocks.
      const clock = 'let calls = 0; Date.now = () => 1700000000000 - (calls++ ? 60000 : 0)'
      const server = spawn(
        process.execPath,
        [
          '--import',
          `data:text/javascript,${encodeURIComponent(clock)}`,
          fileURLToPath(new URL('../e2e/utils/mcp-elicitation-server.mjs', import.meta.url)),
          evidencePath,
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
        assert.equal(next.done, false)
        return JSON.parse(next.value)
      }
      send({
        id: 1,
        method: 'tools/call',
        params: {
          name: 'confirm_inner_site_access',
          arguments: { scenario },
        },
      })
      const request = await receive()
      assert.equal(request.method, 'elicitation/create')
      send({ id: request.id, result: { action: 'cancel' } })
      assert.equal((await receive()).id, 1)
      const records = (await readFile(evidencePath, 'utf8')).trim().split('\n').map(JSON.parse)
      const result = records.find(record => record.event === 'timeout_elicitation_result')
      assert.ok(result.elapsedMs >= 0, 'Elapsed time must not go backwards with the wall clock')
      assert.equal(result.wallElapsedMs, -60000)
      assert.deepEqual(result.result, { action: 'cancel' })
    }
  )
}

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
      send({ id: 4, method: 'tools/call', params: { name: tool, arguments: {} } })
      const repeatedUrl = await receive()
      assert.equal(repeatedUrl.id, first.id, 'The regression fixture must reuse its URL request ID')
      send({ id: repeatedUrl.id, result: { action: 'cancel' } })
      let repeatedForm = await receive()
      if (verifyAccept) {
        send({ id: repeatedForm.id, result: { action: 'accept' } })
        repeatedForm = await receive()
      }
      assert.equal(
        repeatedForm.id,
        next.id,
        'The regression fixture must reuse its form request ID'
      )
      assert.equal(
        (await records()).filter(record => record.event === 'elicitation_result').length,
        1,
        'The old answer must not settle a repeated form'
      )
      send({ id: repeatedForm.id, result: { action: 'accept', content: { audience: 'owner' } } })
      const repeatedComplete = await receive()
      assert.equal(repeatedComplete.id, 4)
      assert.equal(repeatedComplete.result.isError, false)
      assert.equal(
        (await records()).filter(record => record.event === 'elicitation_result').length,
        2,
        'The repeated form did not record exactly one new answer'
      )
    }
  )
}
