import { Readable } from 'node:stream'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { expect, test, vi } from 'vitest'
import { createDesktopScenario } from '../e2e/desktop/scenarios/local-artifact-declaration.scenario.mjs'

vi.mock('../e2e/desktop/modules/shared.mjs', async importOriginal => ({
  ...(await importOriginal()),
  createSingleRootLocalProject: vi.fn(),
  selectE2EModel: vi.fn(),
}))

async function activeScenario(workspacePath) {
  const scenario = createDesktopScenario({ workspacePath, uiTimeoutMs: 100 })
  const stopBeforeUi = new Error('Stop before desktop UI setup')
  await expect(
    scenario.verify({
      command: async () => {
        throw stopBeforeUi
      },
    })
  ).rejects.toBe(stopBeforeUi)
  return scenario
}

async function respond(scenario, output) {
  const request = Readable.from([
    JSON.stringify({
      tools: [{ type: 'function', name: 'exec_command' }],
      input: [
        { role: 'user', content: 'WEWORK_LOCAL_ARTIFACT_DECLARATION' },
        ...(output === undefined
          ? []
          : [{ type: 'function_call_output', call_id: 'local-artifact-generate', output }]),
      ],
    }),
  ])
  request.method = 'POST'
  let body = ''
  await scenario.handleHttp(
    request,
    {
      writeHead() {},
      end(value) {
        body = value
      },
    },
    new URL('http://fixture/v1/responses')
  )
  return body
}

test.each([0, 1, 2])(
  'frames CLI metadata before merged stderr for path length offset %s',
  async offset => {
    const root = fs.mkdtempSync(path.join(tmpdir(), 'artifact-frame' + 'x'.repeat(offset) + '-'))
    try {
      const scenario = await activeScenario(root)
      const events = (await respond(scenario))
        .split('\n')
        .filter(line => line.startsWith('data: '))
        .map(line => JSON.parse(line.slice(6)))
      const call = events.find(
        event => event.type === 'response.output_item.done' && event.item?.type === 'function_call'
      ).item
      const command = JSON.parse(call.arguments).cmd
      const script = Buffer.from(command.match(/Buffer.from\('([^']+)'/)[1], 'base64').toString(
        'utf8'
      )
      let output = ''
      const declare = vi.fn((_binary, args) => {
        const name = args.at(-1)
        const localPath = path.join(root, name)
        const content = fs.readFileSync(localPath)
        return (
          '[WEGENT_ARTIFACT]' +
          JSON.stringify({
            workspace_root: root,
            relative_path: name,
            name,
            file_size: content.length,
            mime_type: 'text/plain',
            modified_at: 1793657415,
            sha256: createHash('sha256').update(content).digest('hex'),
            local_path: localPath,
          }) +
          '\n'
        )
      })
      runInNewContext(script, {
        Buffer,
        require: name => ({ fs, path, child_process: { execFileSync: declare } })[name],
        process: {
          env: { WEGENT_TASK_WORKSPACE: root, WEGENT_EXECUTOR_BINARY: '/fixture/executor' },
          stdout: {
            write: value => {
              output += value
            },
          },
        },
      })
      expect(declare).toHaveBeenCalledOnce()
      expect(await respond(scenario, output + 'executor startup: process entered\n')).toContain(
        'LOCAL_ARTIFACT_DECLARATION_COMPLETE'
      )
      expect(scenario.diagnostics().declaration.encodedTail).not.toContain('executor')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
)

test('retains bounded artifact parser evidence without accepting malformed metadata', async () => {
  const scenario = createDesktopScenario({ workspacePath: '/fixture', uiTimeoutMs: 100 })
  const stopBeforeUi = new Error('Stop before desktop UI setup')
  await expect(
    scenario.verify({
      command: async () => {
        throw stopBeforeUi
      },
    })
  ).rejects.toBe(stopBeforeUi)
  const decoded =
    JSON.stringify({ name: 'local report.md', detail: 'x'.repeat(500) }) + 'unexpected'
  const encoded = Buffer.from(decoded).toString('base64')
  const request = Readable.from([
    JSON.stringify({
      input: [
        { role: 'user', content: 'WEWORK_LOCAL_ARTIFACT_DECLARATION' },
        {
          type: 'function_call_output',
          call_id: 'local-artifact-generate',
          output: `LOCAL_ARTIFACT_RESULT:${encoded}\n`,
        },
      ],
    }),
  ])
  request.method = 'POST'
  await expect(
    scenario.handleHttp(request, {}, new URL('http://fixture/v1/responses'))
  ).rejects.toThrow(SyntaxError)
  expect(scenario.diagnostics()).toMatchObject({
    declaration: {
      encodedLength: encoded.length,
      decodedBytes: Buffer.byteLength(decoded),
      encodedTail: encoded.slice(-128),
      decodedTail: decoded.slice(-160),
    },
  })
  expect(scenario.diagnostics().declaration.encodedTail.length).toBeLessThanOrEqual(128)
  expect(scenario.diagnostics().declaration.decodedTail.length).toBeLessThanOrEqual(160)
})
