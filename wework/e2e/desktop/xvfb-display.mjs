import { existsSync } from 'node:fs'

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
