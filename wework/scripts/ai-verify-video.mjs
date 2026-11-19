import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createDesktopControlClient } from './ai-verify-devtools.mjs'

const framesPerSecond = 5
const frameIntervalMs = 1_000 / framesPerSecond
const captureTimeoutMs = 12_000
const encoderTimeoutMs = 15_000
const pngPrefix = 'data:image/png;base64,'

export class VerifyVideoRecorder {
  #active = null

  constructor(directory) {
    this.directory = directory
  }

  async start() {
    if (this.#active) throw new Error('A video recording is already active')
    const active = {
      stop: new AbortController(),
      video: join(this.directory, `video-${randomUUID()}.mp4`),
    }
    this.#active = active
    const { promise: ready, resolve, reject } = Promise.withResolvers()
    active.finished = recordVideo(this.directory, active, resolve)
    // Keep a background recording failure available for the stop command.
    active.finished.catch(reject)
    try {
      await ready
      return { video: active.video, recording: true }
    } catch (error) {
      if (this.#active === active) this.#active = null
      throw error
    }
  }

  async stop() {
    const active = this.#active
    if (!active) return null
    active.stop.abort()
    try {
      await active.finished
      return active.video
    } finally {
      if (this.#active === active) this.#active = null
    }
  }
}

async function recordVideo(directory, active, onReady) {
  const dispatch = await createDesktopControlClient(directory, '/desktop', captureTimeoutMs)
  const firstFrame = await captureFrame(dispatch)
  const temporary = `${active.video}.partial`
  await writeFile(temporary, '', { mode: 0o600, flag: 'wx' })
  let encoder
  try {
    encoder = startEncoder(temporary)
    await encoder.write(firstFrame)
    onReady()
    const captureError = await sampleFrames(dispatch, encoder, firstFrame, active.stop.signal)
    await encoder.finish()
    await rename(temporary, active.video)
    if (captureError)
      throw new Error(`Video capture ended early: ${captureError.message}. Saved ${active.video}`)
  } finally {
    await encoder?.dispose()
    await rm(temporary, { force: true })
  }
}

async function captureFrame(dispatch) {
  const { dataUrl } = await dispatch({ action: 'screenshot' })
  if (!dataUrl?.startsWith(pngPrefix) || dataUrl.length === pngPrefix.length)
    throw new Error('Invalid video frame from Electron')
  return Buffer.from(dataUrl.slice(pngPrefix.length), 'base64')
}

async function sampleFrames(dispatch, encoder, firstFrame, signal) {
  const startedAt = performance.now()
  let frame = firstFrame
  let frames = 1
  while (!signal.aborted) {
    await delay(Math.max(0, startedAt + frames * frameIntervalMs - performance.now()), null, {
      signal,
    }).catch(error => {
      if (!signal.aborted) throw error
    })
    if (signal.aborted) break
    let nextFrame
    try {
      nextFrame = await captureFrame(dispatch)
    } catch (error) {
      return error
    }
    // Preserve elapsed time when a capture takes longer than a frame interval.
    const nextIndex = Math.max(
      frames,
      Math.floor((performance.now() - startedAt) / frameIntervalMs)
    )
    for (; frames < nextIndex; frames += 1) await encoder.write(frame)
    await encoder.write(nextFrame)
    frame = nextFrame
    frames += 1
  }
}

function startEncoder(output) {
  const child = spawn(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'image2pipe',
      '-framerate',
      String(framesPerSecond),
      '-c:v',
      'png',
      '-i',
      'pipe:0',
      '-vf',
      'scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1',
      '-an',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      '-f',
      'mp4',
      output,
    ],
    { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true }
  )
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => {
    stderr = (stderr + chunk).slice(-4000)
  })
  const closed = once(child, 'close').then(
    ([code, signal]) =>
      code === 0 ? null : new Error(`FFmpeg failed (${signal ?? code}): ${stderr.trim()}`),
    error =>
      error.code === 'ENOENT'
        ? new Error('Video recording requires FFmpeg with libx264 on PATH')
        : error
  )
  // Writable also emits an error when its write callback receives an error.
  child.stdin.on('error', () => {})
  async function guard(operation) {
    const timeout = setTimeout(() => child.kill('SIGKILL'), encoderTimeoutMs)
    try {
      return await operation
    } finally {
      clearTimeout(timeout)
    }
  }
  return {
    async write(frame) {
      try {
        await guard(
          new Promise((resolve, reject) =>
            child.stdin.write(frame, error => (error ? reject(error) : resolve()))
          )
        )
      } catch (error) {
        child.stdin.end()
        throw (await guard(closed)) ?? error
      }
    },
    async finish() {
      child.stdin.end()
      const error = await guard(closed)
      if (error) throw error
    },
    async dispose() {
      child.kill('SIGKILL')
      await closed
    },
  }
}
