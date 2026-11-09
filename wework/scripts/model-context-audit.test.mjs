// @vitest-environment node
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { assertNativeModelContext } from '../e2e/desktop/modules/model-context-audit.mjs'
import { startModelRequestCapture } from '../e2e/desktop/modules/model-request-capture.mjs'

const native = 'Native Codex instruction fixture'
const host = [
  'Wework human participation:',
  'Wework host workflows:',
  'Wework source-content safety:',
].join('\n')
const request = () => ({ instructions: native, input: [{ role: 'developer', content: host }] })

describe('actual model context audit', () => {
  test('accepts exactly one native prompt and host policy without unused skill bodies', () => {
    expect(assertNativeModelContext(request(), native, ['Unused skill body'])).toEqual({
      nativeInstructions: 1,
      duplicateHostSections: 0,
      unusedSkillBodies: 0,
    })
  })

  test.each([native, 'Wework host workflows:', 'wework-runtime:coding', 'Unused skill body'])(
    'rejects duplicate or unwanted context: %s',
    marker => {
      const body = request()
      body.input.push({ role: 'developer', content: marker })
      expect(() => assertNativeModelContext(body, native, ['Unused skill body'])).toThrow()
    }
  )

  test('rejects missing native instructions and missing host policy', () => {
    expect(() => assertNativeModelContext({}, native)).toThrow('exactly once')
    expect(() => assertNativeModelContext({ instructions: native }, native)).toThrow(
      'Host instructions'
    )
  })

  test('captures the real model payload in an independent process without logging headers', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'model-capture-contract-'))
    let received
    const upstream = createServer(async (incoming, response) => {
      const chunks = []
      for await (const chunk of incoming) chunks.push(chunk)
      received = JSON.parse(Buffer.concat(chunks).toString())
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ ok: true }))
    })
    let capture
    try {
      await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
      capture = await startModelRequestCapture({
        target: `http://127.0.0.1:${upstream.address().port}`,
        resultDir: directory,
      })
      expect(capture.pid).not.toBe(process.pid)
      const body = request()
      const response = await fetch(`${capture.url}/v1/responses`, {
        method: 'POST',
        headers: { authorization: 'Bearer synthetic-header-not-for-evidence' },
        body: JSON.stringify(body),
      })
      expect(await response.json()).toEqual({ ok: true })
      expect(received).toEqual(body)
      const evidence = await readFile(join(directory, 'requests.jsonl'), 'utf8')
      expect(JSON.parse(evidence)).toEqual(body)
      expect(evidence).not.toContain('synthetic-header-not-for-evidence')
      expect(() => assertNativeModelContext(JSON.parse(evidence), native)).not.toThrow()
    } finally {
      capture?.close()
      upstream.closeAllConnections()
      await new Promise(resolve => upstream.close(resolve))
      await rm(directory, { recursive: true, force: true })
    }
  }, 15_000)
})
