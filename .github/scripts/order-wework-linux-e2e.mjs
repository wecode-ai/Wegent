import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import {
  DESKTOP_CHECKPOINTS,
  expandDesktopCheckpoints,
} from '../../wework/e2e/desktop/checkpoints.mjs'

const measurements = JSON.parse(
  readFileSync(
    new URL('../ci/wework-linux-checkpoint-durations.json', import.meta.url),
    'utf8',
  ),
)

export function orderLinuxCheckpoints(
  segments,
  scope,
  seconds = measurements.scopes[scope],
) {
  if (!['core', 'cloud'].includes(scope))
    throw new Error(`Unknown Linux E2E scope: ${scope}`)
  const checkpoints = expandDesktopCheckpoints(segments)
  for (const checkpoint of checkpoints) {
    if (!DESKTOP_CHECKPOINTS.includes(checkpoint)) {
      throw new Error(`Unknown desktop E2E checkpoint: ${checkpoint}`)
    }
    const duration = seconds[checkpoint]
    if (
      duration !== undefined &&
      (!Number.isFinite(duration) || duration <= 0)
    ) {
      throw new Error(
        `Invalid Linux E2E duration for ${checkpoint}: ${duration}`,
      )
    }
  }
  // Start unmeasured additions first so a new long checkpoint cannot become a tail.
  // Stable sorting retains selection order for equal or unknown durations.
  return checkpoints.sort(
    (a, b) => (seconds[b] ?? Infinity) - (seconds[a] ?? Infinity),
  )
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const segments = (process.env.WEWORK_E2E_SEGMENTS ?? '')
    .split(',')
    .filter(Boolean)
  if (!segments.length)
    throw new Error('WEWORK_E2E_SEGMENTS must select at least one checkpoint')
  console.log(
    orderLinuxCheckpoints(segments, process.env.WEWORK_E2E_PARALLEL_SCOPE).join(
      ',',
    ),
  )
}
