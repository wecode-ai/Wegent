import type { App, Session } from 'electron'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'

/** Choose a real download destination only for the isolated desktop runner. */
export function installE2EBrowserDownloads({
  environment,
  app,
  session,
  isHostWindow,
}: {
  environment: NodeJS.ProcessEnv
  app: Pick<App, 'setPath'>
  session: Pick<Session, 'on'>
  isHostWindow: (id: number) => boolean
}): void {
  const directory = environment.WEWORK_E2E_DOWNLOADS_DIR?.trim()
  if (environment.VITE_WEWORK_E2E !== 'true' || !environment.WEWORK_E2E_CONTROL_URL || !directory)
    return
  const root = resolve(directory)
  app.setPath('downloads', root)
  session.on('will-download', (_event, item, contents) => {
    if (!contents || !isHostWindow(contents.id)) return
    const filename = item.getFilename()
    const destination = resolve(root, filename)
    const location = relative(root, destination)
    if (
      !filename ||
      basename(filename) !== filename ||
      !location ||
      location === '..' ||
      location.startsWith('..' + sep) ||
      isAbsolute(location)
    ) {
      item.cancel()
      return
    }
    item.setSavePath(destination)
    item.once('done', (_doneEvent, state) => {
      console.info(
        '[Wework E2E] browser-download',
        JSON.stringify({ completed: state === 'completed' })
      )
    })
  })
}
