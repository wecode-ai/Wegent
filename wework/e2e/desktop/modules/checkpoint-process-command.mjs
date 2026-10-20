import { join } from 'node:path'

export function resolveCheckpointProcess({
  args,
  scriptDir,
  environment = process.env,
  platform = process.platform,
  executable = process.execPath,
}) {
  const taskArgs = [join(scriptDir, 'task-flow.e2e.mjs'), ...args]
  if (platform !== 'linux' || environment.WEWORK_E2E_ISOLATED_XVFB !== 'true') {
    return { command: executable, args: taskArgs }
  }

  const segmentIndex = args.indexOf('--segment')
  const nativeAccessibility =
    segmentIndex >= 0 && args[segmentIndex + 1] === 'native-directory-picker'
  return {
    command: 'xvfb-run',
    args: [
      '-a',
      '--server-args=-screen 0 1280x720x24',
      ...(nativeAccessibility ? ['dbus-run-session', '--'] : []),
      'sh',
      join(scriptDir, 'run-with-openbox.sh'),
      // Keep an X11 client connected so Xvfb cannot reset the AT-SPI root property.
      ...(nativeAccessibility ? ['sh', join(scriptDir, 'run-with-native-accessibility.sh')] : []),
      executable,
      ...taskArgs,
    ],
  }
}
