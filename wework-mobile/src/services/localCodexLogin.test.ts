import { describe, expect, it, vi } from 'vitest'
import { LocalCodexLogin, localCodexLogin } from './localCodexLogin'

const login = {
  type: 'chatgptDeviceCode',
  loginId: 'login-1',
  userCode: 'ABCD-1234',
  verificationUrl: 'https://auth.openai.com/codex/device',
  processGeneration: 4,
}
function setup() {
  let emit: (event: Record<string, unknown>) => void = () => {}
  const runtime = {
    onEvent: (listener: typeof emit) => {
      emit = listener
      return vi.fn()
    },
    request: vi.fn().mockResolvedValue(login),
  }
  const session = new LocalCodexLogin(runtime)
  return {
    session,
    request: runtime.request,
    event: (event: string, payload: object) => emit({ event, payload }),
  }
}
describe('official Codex device login', () => {
  it('retains a pending login across settings page mounts for the same runtime', async () => {
    let emit!: (value: Record<string, unknown>) => void
    const runtime = {
      request: vi.fn().mockResolvedValue(login),
      onEvent: (listener: typeof emit) => {
        emit = listener
        return vi.fn()
      },
    }
    const first = localCodexLogin(runtime)
    await first.start()
    const later = localCodexLogin(runtime)
    expect(later).toBe(first)
    expect(later.snapshot.login?.loginId).toBe(login.loginId)
    emit({
      event: 'runtime.codex.auth.login.completed',
      payload: { loginId: login.loginId, processGeneration: 4, success: true },
    })
    expect(later.snapshot.completed).toBe(1)
  })
  it('uses the official browser OAuth contract and requires its own completion event', async () => {
    const { session, request, event } = setup()
    request.mockResolvedValue({
      type: 'chatgpt',
      loginId: 'browser-1',
      authUrl: 'https://auth.openai.com/oauth/authorize?state=private',
      processGeneration: 4,
    })
    await session.start('chatgpt')
    expect(request).toHaveBeenCalledWith('runtime.codex.auth.login.start', { type: 'chatgpt' })
    expect(session.snapshot.completed).toBe(0)
    event('runtime.codex.auth.login.completed', {
      loginId: 'browser-1',
      processGeneration: 3,
      success: true,
    })
    expect(session.snapshot.login).not.toBeNull()
    event('runtime.codex.auth.login.completed', {
      loginId: 'browser-1',
      processGeneration: 4,
      success: true,
    })
    expect(session.snapshot).toEqual({ login: null, error: null, completed: 1 })
  })
  it('rejects a non-official browser URL without declaring login success', async () => {
    const { session, request } = setup()
    request.mockResolvedValue({
      type: 'chatgpt',
      loginId: 'browser-1',
      authUrl: 'https://auth.openai.com.attacker.test/login',
      processGeneration: 4,
    })
    await expect(session.start('chatgpt')).rejects.toThrow('非官方')
    expect(session.snapshot.login).toBeNull()
  })
  it('keeps the new login pending even when an account is already signed in', async () => {
    const { session, request } = setup()
    await session.start()
    expect(request).toHaveBeenCalledExactlyOnceWith('runtime.codex.auth.login.start', {
      type: 'chatgptDeviceCode',
    })
    expect(session.snapshot.login?.loginId).toBe('login-1')
    expect(session.snapshot.completed).toBe(0)
  })
  it('handles completion before the login-start response and ignores unrelated IDs', async () => {
    const { session, request, event } = setup()
    request.mockImplementation(async () => {
      event('runtime.codex.auth.login.completed', {
        loginId: 'other',
        success: false,
        error: 'denied',
        processGeneration: 4,
      })
      event('runtime.codex.auth.login.completed', {
        loginId: 'login-1',
        success: true,
        processGeneration: 4,
      })
      return login
    })
    await session.start()
    expect(session.snapshot).toEqual({ login: null, error: null, completed: 1 })
  })
  it('displays official expiration errors and ignores obsolete app-server exits', async () => {
    const { session, event } = setup()
    await session.start()
    event('runtime.codex.app_server.exited', { processGeneration: 3 })
    event('runtime.codex.auth.login.completed', {
      loginId: null,
      success: true,
      processGeneration: 4,
    })
    expect(session.snapshot.login).not.toBeNull()
    event('runtime.codex.auth.login.completed', {
      loginId: 'login-1',
      success: false,
      error: 'device code expired',
      processGeneration: 4,
    })
    expect(session.snapshot).toEqual({ login: null, error: 'device code expired', completed: 0 })
  })
  it('requires native cancellation acknowledgment and never interprets cancellation as login', async () => {
    const { session, request } = setup()
    await session.start()
    request.mockResolvedValue({ status: 'unknown' })
    await expect(session.cancel()).rejects.toThrow('未确认')
    expect(session.snapshot.login).not.toBeNull()
    request.mockResolvedValue({ status: 'canceled' })
    await session.cancel()
    expect(session.snapshot).toEqual({ login: null, error: null, completed: 0 })
  })
  it('does not open an untrusted login URL', async () => {
    const { session, request } = setup()
    request.mockResolvedValue({ ...login, verificationUrl: 'https://example.test/login' })
    await expect(session.start()).rejects.toThrow('非官方')
    expect(session.snapshot.login).toBeNull()
  })
})
