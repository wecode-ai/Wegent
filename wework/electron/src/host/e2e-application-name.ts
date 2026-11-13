/** Give independently signed macOS fixtures independent native credential identities. */
export function desktopE2EApplicationName(
  productName: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): string {
  const identifier = environment.WEWORK_APP_IDENTIFIER?.trim()
  if (
    platform !== 'darwin' ||
    environment.VITE_WEWORK_E2E !== 'true' ||
    !environment.WEWORK_E2E_CONTROL_URL?.trim() ||
    environment.WEWORK_E2E_REQUIRE_RELEASE_PACKAGE === '1' ||
    !identifier?.match(/^io\.wecode\.wework\.e2e\.run\d+$/)
  )
    return productName

  // Electron keys its macOS native credential service by application name.
  // Independently signed clones must not read another clone's protected key.
  return `${productName} ${identifier}`
}
