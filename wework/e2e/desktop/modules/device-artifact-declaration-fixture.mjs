import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { nodeInlineCommand } from './node-command.mjs'
import { toolOutputText } from './response-protocol.mjs'

export const ARTIFACT_DECLARATION_CALL_ID = 'desktop-artifact-generate'
const RESULT_MARKER = '[WEGENT_ARTIFACT]'

export function artifactDeclarationCommand(content) {
  const script = `
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const root = process.env.WEGENT_TASK_WORKSPACE
const executor = process.env.WEGENT_EXECUTOR_BINARY
if (!root || !executor || !process.env.WEGENT_BACKEND_TASK_ID) {
  throw new Error('Missing associated Backend Task environment')
}
fs.mkdirSync(root, { recursive: true })
fs.writeFileSync(path.join(root, 'report.md'), ${JSON.stringify(content)})
const declaration = spawnSync(executor, ['artifact', 'declare', '--path', 'report.md'], {
  cwd: root,
  encoding: 'utf8',
})
if (declaration.error) throw declaration.error
process.stdout.write(declaration.stdout ?? '')
process.stderr.write(declaration.stderr ?? '')
process.exit(declaration.status ?? 1)
`
  return nodeInlineCommand(script)
}

export function assertArtifactDeclarationOutput(body, content) {
  let output = toolOutputText(body, ARTIFACT_DECLARATION_CALL_ID)
  assert.equal(typeof output, 'string', 'The artifact declaration tool did not return output')
  if (output.trimStart().startsWith('[') && !output.trimStart().startsWith(RESULT_MARKER)) {
    const blocks = JSON.parse(output)
    assert.ok(
      Array.isArray(blocks) &&
        blocks.every(block => block?.type === 'input_text' && typeof block.text === 'string'),
      'The artifact declaration returned malformed text blocks'
    )
    // Preserve execution metadata as well as stdout when decoding programmatic exec output.
    output = blocks.map(block => block.text).join('\n')
  }
  for (const match of output.matchAll(/(?:Process exited with code|Exit code:)\s*(-?\d+)/g)) {
    assert.equal(Number(match[1]), 0, `The artifact declaration tool failed: ${output}`)
  }
  const declarations = output.split(/\r?\n/).filter(line => line.startsWith(RESULT_MARKER))
  assert.equal(declarations.length, 1, `Expected one successful artifact declaration: ${output}`)
  const artifact = JSON.parse(declarations[0].slice(RESULT_MARKER.length))
  assert.ok(Number.isInteger(artifact.id) && artifact.id > 0, 'The declared artifact has no id')
  assert.equal(artifact.name, 'report.md')
  assert.equal(artifact.relative_path, 'report.md')
  assert.equal(artifact.file_size, Buffer.byteLength(content))
  assert.equal(artifact.sha256, createHash('sha256').update(content).digest('hex'))
  assert.match(
    artifact.download_url,
    new RegExp(`^/api/tasks/[1-9]\\d*/remote-workspace/artifacts/${artifact.id}/file$`)
  )
  return artifact
}
