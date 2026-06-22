type ApiResponse = {
  ok(): boolean
  status(): number
  text(): Promise<string>
}

type ApiRequestContext = {
  post(url: string, options: { data: { password: string } }): Promise<ApiResponse>
}

export async function ensureBootstrapAdminPasswordInitialized(
  request: ApiRequestContext,
  apiBaseUrl: string,
  password: string
): Promise<void> {
  const setupResponse = await request.post(`${apiBaseUrl}/api/auth/admin-password/setup`, {
    data: {
      password,
    },
  })

  if (setupResponse.ok() || setupResponse.status() === 409) {
    return
  }

  throw new Error(`Failed to set bootstrap admin password: ${await setupResponse.text()}`)
}
