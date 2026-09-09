interface ComputerUseStartupOptions {
  isShuttingDown: () => boolean
  readPreferences: () => Promise<{ computerUseEnabled?: boolean }>
  setEnabled: (enabled: boolean) => Promise<unknown>
}

export async function restoreComputerUseAfterStartup(
  options: ComputerUseStartupOptions
): Promise<void> {
  if (options.isShuttingDown()) return
  const preferences = await options.readPreferences()
  if (options.isShuttingDown() || preferences.computerUseEnabled !== true) return
  await options.setEnabled(true)
}
