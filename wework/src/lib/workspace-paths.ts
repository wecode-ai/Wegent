const WINDOWS_DRIVE_PATH_PATTERN = /^[a-zA-Z]:[\\/]/

/** True for absolute Windows drive-letter paths such as `C:\repo` or `C:/repo`. */
export function isWindowsDriveAbsolutePath(value: string): boolean {
  return WINDOWS_DRIVE_PATH_PATTERN.test(value)
}

/** True for POSIX absolute paths (`/a/b`) or absolute Windows drive-letter paths. */
export function isAbsoluteWorkspacePath(value: string): boolean {
  return value.startsWith('/') || isWindowsDriveAbsolutePath(value)
}

export async function resolveHomeRelativeWorkspacePath(
  path: string,
  deviceId: string,
  getHomeDirectory: (deviceId: string) => Promise<string>
): Promise<string> {
  if (!path.startsWith('~/')) return path
  const home = (await getHomeDirectory(deviceId)).trim().replace(/\\/g, '/')
  if (!isAbsoluteWorkspacePath(home)) throw new Error('Invalid device home directory')
  return `${home.replace(/\/+$/, '')}/${path.slice(2)}`
}
