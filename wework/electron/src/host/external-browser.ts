import { app, shell } from 'electron'
import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { launchDetached } from './local-workspace-openers.js'

const executeFile = promisify(execFile)

/** Open browser content in the HTTPS handler, never the file-type handler. */
export async function openInExternalBrowser(value: string): Promise<void> {
  const url = new URL(value)
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    await shell.openExternal(url.href)
    return
  }
  if (url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost')) {
    throw new Error('Only web URLs and local file URLs can open in an external browser')
  }
  const metadata = await stat(fileURLToPath(url))
  if (!metadata.isFile() && !metadata.isDirectory()) {
    throw new Error('The browser target must be a regular file or directory')
  }

  // Resolving the HTTPS handler avoids selecting Finder, an editor, or a file handler.
  const browser = await app.getApplicationInfoForProtocol('https://example.com')
  if (!browser.path) throw new Error('No default external browser is configured')
  if (process.platform === 'darwin') {
    await executeFile('/usr/bin/open', ['-a', browser.path, url.href], { timeout: 10_000 })
  } else {
    await launchDetached(browser.path, [url.href])
  }
}
