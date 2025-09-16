import type { User } from '@/types/api'
import { apiClient } from '../client'
import { getToken as getTokenBase, setToken as setTokenBase } from '../user'
import { paths } from '@/config/paths'

/**
 * CAS ticket 登录
 */
/**
 * CAS ticket 登录
 * @param ticket CAS登录票据
 * @param service CAS service参数，需与CAS跳转时一致
 */
/**
 * CAS ticket 登录
 * 只 setToken，不请求 /users/me，自动用 paths.casService，错误由调用方处理
 */
export async function loginWithTicket(ticket: string): Promise<void> {
  const service = paths.internal.casService.getHref()
  const res: { access_token: string; token_type: string } = await apiClient.post(
    `/internal/auth/login?ticket=${encodeURIComponent(ticket)}&service=${encodeURIComponent(service)}`
  )
  setTokenBase(res.access_token)
}