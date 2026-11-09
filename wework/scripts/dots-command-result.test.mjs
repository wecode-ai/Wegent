import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  assertDotsCommandSucceeded,
  createDotsCheckedCommand,
  revenueProgram,
} from '../e2e/desktop/modules/dots-story-fixtures.mjs'
import { toolOutputText } from '../e2e/desktop/modules/response-protocol.mjs'

const MARKER = 'DOTS_PRIMARY_CWD_VERIFIED'

test('the negative revenue fixture emits a standalone success marker only after verifying child failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'dots-revenue-negative-'))
  try {
    const directory = join(root, 'revenue-fixture')
    mkdirSync(directory)
    const report = join(directory, 'revenue-report.md')
    const analyze = join(directory, 'analyze.mjs')
    writeFileSync(report, 'existing-report-must-survive')
    writeFileSync(analyze, "throw new Error('Invalid amount: not-a-number')")
    const encoded = Buffer.from(revenueProgram(root, 3)).toString('base64')
    const result = spawnSync(
      process.execPath,
      ['-e', `eval(Buffer.from('${encoded}','base64').toString('utf8'))`],
      { encoding: 'utf8' }
    )
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Invalid amount: not-a-number/)
    assertDotsCommandSucceeded(
      `Process exited with code ${result.status}\n${result.stdout}`,
      'negative-revenue',
      'DOTS_REVENUE_INVALID_AMOUNT'
    )
    assert.equal(readFileSync(report, 'utf8'), 'existing-report-must-survive')
    writeFileSync(analyze, "console.log('unexpected child success')")
    const unexpected = spawnSync(
      process.execPath,
      ['-e', `eval(Buffer.from('${encoded}','base64').toString('utf8'))`],
      { encoding: 'utf8' }
    )
    assert.equal(unexpected.status, 1)
    assert.throws(() =>
      assertDotsCommandSucceeded(
        `Process exited with code ${unexpected.status}\n${unexpected.stdout}${unexpected.stderr}`,
        'negative-revenue',
        'DOTS_REVENUE_INVALID_AMOUNT'
      )
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('polls the original session without resubmission and retains earlier output until exit zero', () => {
  let launches = 0
  const checked = createDotsCheckedCommand(() => {
    launches++
    return 'initial-command'
  })
  const body = (id, output) => ({
    tools: [{ type: 'function', name: 'write_stdin', parameters: { type: 'object' } }],
    input: id ? [{ type: 'function_call_output', call_id: id, output }] : [],
  })
  assert.equal(checked(body(), 'fixture', 'source', MARKER), 'initial-command')
  let events = checked(
    body('fixture', `Process running with session ID 42\n${MARKER}`),
    'fixture',
    'source',
    MARKER
  )
  let call = events.find(event => event.type === 'response.output_item.done').item
  assert.equal(call.name, 'write_stdin')
  assert.equal(JSON.parse(call.arguments).session_id, 42)
  events = checked(
    body(call.call_id, 'Process running with session ID 42\nstill executing'),
    'fixture',
    'source',
    MARKER
  )
  call = events.find(event => event.type === 'response.output_item.done').item
  assert.equal(JSON.parse(call.arguments).session_id, 42)
  assert.equal(
    checked(body(call.call_id, 'Process exited with code 0\n'), 'fixture', 'source', MARKER),
    null
  )
  assert.equal(launches, 1)
})

test('rejects a failing terminal poll despite a marker in an earlier chunk', () => {
  const checked = createDotsCheckedCommand(() => 'initial-command')
  const body = (id, output) => ({
    tools: [{ type: 'function', name: 'write_stdin', parameters: { type: 'object' } }],
    input: [{ type: 'function_call_output', call_id: id, output }],
  })
  const events = checked(
    body('fixture', `Process running with session ID 42\n${MARKER}`),
    'fixture',
    'source',
    MARKER
  )
  const call = events.find(event => event.type === 'response.output_item.done').item
  assert.throws(
    () => checked(body(call.call_id, 'Process exited with code 1\n'), 'fixture', 'source', MARKER),
    /did not exit successfully/
  )
})

test('exposes completed accumulated source facts when the initial running chunk was empty', () => {
  const checked = createDotsCheckedCommand(() => 'initial-command')
  const body = (id, output) => ({
    tools: [{ type: 'function', name: 'write_stdin', parameters: { type: 'object' } }],
    input: [{ type: 'function_call_output', call_id: id, output }],
  })
  const events = checked(
    body('fixture', 'Process running with session ID 42\n'),
    'fixture',
    'source',
    MARKER
  )
  assert.equal(checked.output('fixture'), undefined)
  const call = events.find(event => event.type === 'response.output_item.done').item
  const facts = ['2026-11-20', 'Automatic scheduling deferred', 'Date not specified']
  assert.equal(
    checked(
      body(call.call_id, `Process exited with code 0\n${facts.join('\n')}\n${MARKER}`),
      'fixture',
      'source',
      MARKER
    ),
    null
  )
  for (const fact of facts) assert.ok(checked.output('fixture').includes(fact))
})

function nativeResult(source) {
  const directory = mkdtempSync(join(tmpdir(), 'dots-command-result-'))
  try {
    const encoded = Buffer.from(source).toString('base64')
    const result = spawnSync(
      process.execPath,
      ['-e', `eval(Buffer.from('${encoded}','base64').toString('utf8'))`],
      {
        cwd: directory,
        encoding: 'utf8',
      }
    )
    assert.ifError(result.error)
    // The existing shellCommandResponse Code Mode adapter emits these two text items.
    const output = toolOutputText(
      {
        input: [
          {
            type: 'custom_tool_call_output',
            call_id: 'fixture',
            output: [
              { type: 'input_text', text: `Process exited with code ${result.status}` },
              { type: 'input_text', text: result.stdout + result.stderr },
            ],
          },
        ],
      },
      'fixture'
    )
    return { result, output }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('rejects real eval failures even when Node echoes the success marker in source', () => {
  for (const prefix of ['missingDotsFunction();', 'const broken=;']) {
    const { result, output } = nativeResult(`${prefix}console.log('${MARKER}')`)
    assert.equal(result.status, 1)
    assert.ok(output.includes(MARKER), 'Reproduce the previous includes-only false positive')
    assert.throws(
      () => assertDotsCommandSucceeded(output, 'fixture', MARKER),
      /did not exit successfully/
    )
  }
})

test('requires both native successful completion and an actual standalone marker', () => {
  const { result, output } = nativeResult(`console.log('${MARKER}')`)
  assert.equal(result.status, 0)
  assert.doesNotThrow(() => assertDotsCommandSucceeded(output, 'fixture', MARKER))
  for (const invalid of [
    `Process exited with code 1\n${MARKER}\nProcess exited with code 0`,
    `Process running with session ID 1\n${MARKER}\nProcess exited with code 0`,
    `Process exited with code 0\nconsole.log('${MARKER}')`,
    MARKER,
  ])
    assert.throws(() => assertDotsCommandSucceeded(invalid, 'fixture', MARKER))
  assert.doesNotThrow(() =>
    assertDotsCommandSucceeded(
      `Exit code: 0\nWall time: 1 seconds\nOutput:\n${MARKER}`,
      'fixture',
      MARKER
    )
  )
})
