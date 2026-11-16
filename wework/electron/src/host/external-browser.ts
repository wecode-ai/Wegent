import { app, shell } from 'electron'
import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { launchDetached } from './local-workspace-openers.js'

const executeFile = promisify(execFile)

/** Open browser content in the HTTPS handler, never the file-type handler. */
export async function openInExternalBrowser(value: string): Promise<void> {
  let stage = 'parse-url'
  let protocol = 'unknown'
  try {
    const url = new URL(value)
    protocol = url.protocol
    console.info('[External Browser] Open requested', { protocol })
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      stage = 'open-web-url'
      await shell.openExternal(url.href)
      console.info('[External Browser] Open completed', { protocol })
      return
    }
    if (url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost')) {
      throw new Error('Only web URLs and local file URLs can open in an external browser')
    }
    stage = 'validate-local-file'
    const metadata = await stat(fileURLToPath(url))
    if (!metadata.isFile() && !metadata.isDirectory()) {
      throw new Error('The browser target must be a regular file or directory')
    }

    stage = 'resolve-default-browser'
    // Resolving the HTTPS handler avoids selecting Finder, an editor, or a file handler.
    const browser = await app.getApplicationInfoForProtocol('https://example.com')
    if (!browser.path) throw new Error('No default external browser is configured')
    stage = 'launch-external-browser'
    if (process.platform === 'darwin') {
      await executeFile('/usr/bin/open', ['-a', browser.path, url.href], { timeout: 10_000 })
    } else {
      await launchDetached(browser.path, [url.href])
    }
    console.info('[External Browser] Open completed', { protocol })
  } catch (error) {
    console.error('[External Browser] Open failed', {
      protocol,
      stage,
      errorName: error instanceof Error ? error.name : typeof error,
      errorCode:
        typeof error === 'object' && error && 'code' in error ? String(error.code) : undefined,
    })
    throw error
  }
}
