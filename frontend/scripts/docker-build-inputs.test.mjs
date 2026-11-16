// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = fileURLToPath(new URL('../../', import.meta.url))
const modulePath = 'packages/collaboration/src/templates/builtins.ts'
const importPath = readFileSync(join(root, modulePath), 'utf8').match(
  /import definitions from '([^']+)'/
)[1]
const dataPath = posix.normalize(posix.join(posix.dirname(modulePath), importPath))

// Project only the actual module and its dependency through each stage's COPY rules.
function stageFiles(dockerfile, targetStage) {
  const result = new Map()
  let stage = '',
    workdir = '/'
  for (const rawLine of readFileSync(join(root, dockerfile), 'utf8').split('\n')) {
    const line = rawLine.trim()
    const from = line.match(/^FROM \S+ AS (\S+)/i)
    if (from) {
      stage = from[1]
      workdir = '/'
    }
    if (stage !== targetStage) continue
    const directory = line.match(/^WORKDIR (\S+)/)
    if (directory) workdir = posix.resolve(workdir, directory[1])
    const copy = line.match(/^COPY ([^-]\S*) (\S+)$/)
    if (!copy) continue
    const [, source, destination] = copy
    for (const file of [modulePath, dataPath]) {
      if (file !== source && !file.startsWith(source + '/')) continue
      const suffix = file === source ? '' : file.slice(source.length + 1)
      result.set(file, posix.join(posix.resolve(workdir, destination), suffix))
    }
  }
  return result
}

for (const [dockerfile, stage] of [
  ['docker/frontend/Dockerfile', 'builder'],
  ['docker/standalone/Dockerfile', 'frontend-builder'],
  ['docker/standalone/Dockerfile', 'wework-builder'],
]) {
  test(`${dockerfile} ${stage} includes the shared templates at their import path`, t => {
    const image = mkdtempSync(join(tmpdir(), 'frontend-image-inputs-'))
    t.after(() => rmSync(image, { recursive: true, force: true }))
    const files = stageFiles(dockerfile, stage)
    for (const [source, destination] of files) {
      const target = join(image, destination)
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(join(root, source), target)
    }
    const moduleDestination = files.get(modulePath)
    assert.ok(moduleDestination, 'The shared collaboration module must be copied')
    const dependency = posix.resolve(posix.dirname(moduleDestination), importPath)
    assert.ok(existsSync(join(image, dependency)), `${stage} is missing ${dependency}`)
    assert.ok(Array.isArray(JSON.parse(readFileSync(join(image, dependency), 'utf8'))))
  })
}
