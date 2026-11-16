// @vitest-environment node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { onTestFinished, test } from 'vitest'
import { createVisualizationFixtureWriteCommand } from '../e2e/desktop/modules/visualization-fixture-command.mjs'

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'wework-visualization-command-'))
  onTestFinished(() => rm(directory, { recursive: true, force: true }))
  return directory
}

function runFixtureCommand(fixture, cwd) {
  return spawnSync(createVisualizationFixtureWriteCommand(fixture), {
    shell: true,
    cwd,
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`,
    },
  })
}

test('writes UTF-8 fixtures through the shell without expanding path, HTML, or marker data', async () => {
  const directory = await temporaryDirectory()
  const file = join(directory, "子目录 with space ' quote $() `backtick`", '图表.html')
  const html = `<section title="双引号 'single'">收益计算 ¥105.48\n$(touch expanded) \`touch expanded\`</section>\n`
  const marker = '写入成功 \' " $() `literal`'

  const result = runFixtureCommand({ file, html, marker }, directory)

  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(await readFile(file, 'utf8'), html)
  assert.equal(result.stdout.trimEnd(), marker)
  await assert.rejects(readFile(join(directory, 'expanded')), { code: 'ENOENT' })
})

test('does not print the success marker when the real file write fails', async () => {
  const directory = await temporaryDirectory()
  const blocker = join(directory, 'existing-file')
  await writeFile(blocker, 'not a directory')
  const marker = 'WEWORK_FIXTURE_MUST_NOT_REPORT_SUCCESS'

  const result = runFixtureCommand(
    { file: join(blocker, 'fixture.html'), html: '<section>失败</section>', marker },
    directory
  )

  assert.equal(result.error, undefined)
  assert.notEqual(result.status, 0)
  assert.ok(!`${result.stdout}${result.stderr}`.includes(marker))
})
