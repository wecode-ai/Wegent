export function wrapWindowsScriptCommand(
  command,
  args,
  { platform = process.platform, commandInterpreter = process.env.ComSpec || 'cmd.exe' } = {}
) {
  if (
    platform !== 'win32' ||
    (!command.toLowerCase().endsWith('.cmd') && !command.toLowerCase().endsWith('.bat'))
  ) {
    return { command, args }
  }

  return {
    command: commandInterpreter,
    args: ['/c', command, ...args],
  }
}
