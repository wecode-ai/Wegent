import { DESKTOP_CHECKPOINT_GROUPS, expandDesktopCheckpoints } from './checkpoints.mjs'

/** Expands `--from-segment` into the ordered checkpoints that still run. */
function checkpointRangeFrom(checkpoint, defaults) {
  const startCheckpoint = DESKTOP_CHECKPOINT_GROUPS.get(checkpoint)?.[0] ?? checkpoint
  const startIndex = defaults.indexOf(startCheckpoint)
  return startIndex < 0 ? null : defaults.slice(startIndex)
}

/**
 * Resolves the checkpoints requested on the command line plus the flags that
 * have to be forwarded to each run.
 *
 * Every requested checkpoint is launched as its own `--segment`, so per-segment
 * launch settings (for example the telemetry policy fixture) always match the
 * checkpoint that runs next. Scope flags such as `--cloud-only` are preserved
 * instead of falling back to a single run that would ignore the requested
 * range.
 */
function requestedCheckpointSelection(args, defaults) {
  const flagIndex = args.findIndex(arg => arg === '--segment' || arg === '--from-segment')
  if (flagIndex < 0 || flagIndex + 1 >= args.length) return null
  const checkpoint = args[flagIndex + 1]
  const extraArgs = args.filter((_, index) => index !== flagIndex && index !== flagIndex + 1)
  const checkpoints =
    args[flagIndex] === '--segment'
      ? expandDesktopCheckpoints([checkpoint])
      : checkpointRangeFrom(checkpoint, defaults)
  return checkpoints ? { checkpoints, extraArgs } : null
}

/** Launch arguments for one checkpoint of a requested range. */
function checkpointLaunchArgs(checkpoint, extraArgs = [], cloudOnly = false) {
  return [...(cloudOnly ? ['--cloud-only'] : []), '--segment', checkpoint, ...extraArgs]
}

export { checkpointLaunchArgs, checkpointRangeFrom, requestedCheckpointSelection }
