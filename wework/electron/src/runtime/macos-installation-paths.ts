import { posix } from 'node:path'

const { basename, dirname, join, resolve } = posix

export function macosApplication(executable: string): string {
  const application = resolve(executable, '..', '..', '..')
  if (
    !application.endsWith('.app') ||
    dirname(executable) !== join(application, 'Contents', 'MacOS')
  )
    throw new Error('The installed macOS executable is not inside an application bundle')
  return application
}

export function macosInstallationStage(executable: string, releaseId: string): string {
  const application = macosApplication(executable)
  return join(
    dirname(application),
    `.${basename(application)}.wework-${releaseId}`,
    basename(application)
  )
}
