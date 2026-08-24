let clipboardText = ''

export function installDesktopE2EClipboard(): void {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        clipboardText = text
      },
    },
  })
}

export function getDesktopE2EClipboardText(): string {
  return clipboardText
}
