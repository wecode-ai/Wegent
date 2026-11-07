// @vitest-environment node

import { execFileSync } from 'node:child_process'
import { expect, test } from 'vitest'

const sharedUrl = new URL('../../e2e/desktop/modules/shared.mjs', import.meta.url).href

test.each([
  { args: [], enabled: true },
  { args: ['--memory-only'], enabled: false },
  { args: ['--send-rejection-only'], enabled: false },
  { args: ['--tool-block-order-only'], enabled: true },
  { args: ['--model-switch-only'], enabled: true },
  { args: ['--segment', 'rendering-extensions'], enabled: true },
  { args: ['--segment', 'model-routing'], enabled: true },
  { args: ['--segment', 'stand-in'], enabled: false },
  { args: ['--from-segment', 'model-routing'], enabled: true },
  { args: ['--cloud-only'], enabled: true },
  { args: ['--cloud-only', '--segment', 'model-routing'], enabled: true },
  { args: ['--cloud-only', '--segment', 'conversation-state'], enabled: false },
  { args: ['--cloud-features-only'], enabled: false },
  { args: ['--cloud-vision-only'], enabled: false },
])('selects the real tool-details fixture for $args: $enabled', ({ args, enabled }) => {
  const result = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { shouldConfigureToolDetailsMcp } from ${JSON.stringify(sharedUrl)}; console.log(shouldConfigureToolDetailsMcp())`,
      '--',
      ...args,
    ],
    { encoding: 'utf8', timeout: 10000 }
  )
  expect(result.trim()).toBe(String(enabled))
})
