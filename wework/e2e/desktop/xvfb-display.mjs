import { existsSync } from 'node:fs'
import { chmod, mkdir } from 'node:fs/promises'

/** Prepare Xtrans's shared socket directory before parallel X servers race to create it. */
export async function prepareXvfbSocketDirectory(directory = '/tmp/.X11-unix') {
  const created = await mkdir(directory, { recursive: true, mode: 0o1777 })
  if (created) await chmod(directory, 0o1777)
}

function isDisplayOccupied(number) {
  return existsSync(`/tmp/.X${number}-lock`) || existsSync(`/tmp/.X11-unix/X${number}`)
}

/** Reserve one non-reused display per checkpoint within a runner process. */
export function createXvfbDisplayAllocator(isOccupied = isDisplayOccupied) {
  let nextDisplay = 99
  return () => {
    // Reserve in the parent before spawning: parallel xvfb-run scans can all
    // observe the same free number before any X server creates its lock file.
    while (isOccupied(nextDisplay)) nextDisplay += 1
    return nextDisplay++
  }
}
