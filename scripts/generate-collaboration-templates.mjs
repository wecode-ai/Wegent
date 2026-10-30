// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(
  new URL('../packages/collaboration/package.json', import.meta.url),
)
const { stringify } = require('yaml')
const definitions = JSON.parse(
  await readFile(
    new URL('../shared/data/collaboration-templates.json', import.meta.url),
    'utf8',
  ),
)
const target = new URL(
  '../backend/init_data/04-collaboration-templates.yaml',
  import.meta.url,
)
await writeFile(
  target,
  '# Generated from shared/data/collaboration-templates.json.\n# Regenerate: pnpm --filter @wegent/collaboration exec node ../../scripts/generate-collaboration-templates.mjs\n' +
    definitions.map((document) => '---\n' + stringify(document)).join(''),
)
console.log(fileURLToPath(target))
