/**
 * Electron patches fs operations for any path ending in .asar. Synthetic test
 * fixtures are ordinary files or directories, so tests that create them must
 * bypass the archive interpretation while still exercising the production code.
 */
export function disableAmbientAsarInterception(): void {
  process.noAsar = true
}

export function restoreAmbientAsarInterception(): void {
  process.noAsar = false
}
