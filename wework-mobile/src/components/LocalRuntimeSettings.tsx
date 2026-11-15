import * as Clipboard from 'expo-clipboard'
import * as WebBrowser from 'expo-web-browser'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { AppState, StyleSheet, View } from 'react-native'
import { Button, Text, useTheme } from 'react-native-paper'
import type { LocalRuntime, LocalRuntimeStatus } from '@/services/localRuntime'
import { localCodexLogin } from '@/services/localCodexLogin'
import { ErrorNotice } from './errors/ErrorNotice'
import { confirmModelDataSharing } from '@/services/privacyPolicy'

interface CodexAccount {
  id: string
  accountType: string
  email?: string
  planType?: string
}

const STATE_LABELS: Record<LocalRuntimeStatus['state'], string> = {
  stopped: '未启动',
  starting: '正在准备执行环境',
  running: '已就绪',
  stopping: '正在停止',
  failed: '启动失败',
}

export function LocalRuntimeSettings({
  runtime,
  status,
  visible,
  onChanged,
  section = 'all',
}: {
  runtime: LocalRuntime
  status: LocalRuntimeStatus
  visible: boolean
  section?: 'all' | 'accounts' | 'execution'
  onChanged: () => Promise<void>
}) {
  const theme = useTheme()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [account, setAccount] = useState<CodexAccount | null>(null)
  const [accounts, setAccounts] = useState<CodexAccount[]>([])
  const loginSession = useMemo(() => localCodexLogin(runtime), [runtime])
  const loginState = useSyncExternalStore(
    listener => loginSession.subscribe(listener),
    () => loginSession.snapshot
  )
  const { login } = loginState
  const completedRef = useRef(0)
  const running = status.state === 'running'
  useEffect(() => {
    loginSession.connect()
  }, [loginSession])
  useEffect(() => {
    if (!running) loginSession.reset()
  }, [running, loginSession])
  const act = async (operation: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await operation()
    } catch (cause) {
      setError(cause)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!running || !visible || section === 'execution') return
    let disposed = false
    const refresh = async () => {
      try {
        const response = await runtime.request<{
          activeAccountId: string | null
          accounts: CodexAccount[]
        }>('runtime.codex.accounts.list')
        if (disposed) return
        setAccounts(response.accounts)
        setAccount(response.accounts.find(item => item.id === response.activeAccountId) ?? null)
        if (loginState.completed !== completedRef.current) {
          completedRef.current = loginState.completed
          await onChanged()
        }
      } catch (cause) {
        if (!disposed) setError(cause)
      }
    }
    void refresh()
    const foreground = AppState.addEventListener('change', state => {
      if (state === 'active') void refresh()
    })
    return () => {
      disposed = true
      foreground.remove()
    }
  }, [runtime, running, visible, section, loginState.completed, onChanged])

  const openLogin = async (login: NonNullable<typeof loginState.login>) => {
    if (login.type === 'chatgptDeviceCode') {
      await Clipboard.setStringAsync(login.userCode)
      await WebBrowser.openBrowserAsync(login.verificationUrl)
    } else await WebBrowser.openBrowserAsync(login.authUrl)
  }
  const startLogin = async (type: 'chatgpt' | 'chatgptDeviceCode' = 'chatgpt') => {
    const response = await loginSession.start(type)
    if (loginSession.snapshot.login) await openLogin(response)
  }

  return (
    <View style={styles.container}>
      <Text variant="titleMedium">{section === 'accounts' ? 'OpenAI 账号' : '这台手机'}</Text>
      <Text variant="bodyMedium">
        {status.supported ? STATE_LABELS[status.state] : '此安装包不含手机本地执行环境'}
      </Text>
      {status.supported && (
        <>
          {(section !== 'accounts' || !running) && (
            <>
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                Executor、Codex 和项目文件在手机上运行。可登录 OpenAI 账号或配置本机模型；登录
                Wegent 后还可使用后端模型。
              </Text>
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                本机执行需要选择“完整访问”，范围限于 App 沙盒；此环境不支持 Linux
                的只读和工作区权限隔离。
              </Text>
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                长任务请保持 App 在前台。切到后台后可短时继续，系统额度耗尽时会中断并提示；划掉 App
                会停止执行。
              </Text>
              {status.background === 'expired' && (
                <ErrorNotice
                  title="后台执行已中断"
                  error="后台执行额度已耗尽。请保持 App 在前台，并查看会话状态。"
                  testID="local-runtime-background-expired"
                />
              )}
              {status.background === 'unavailable' && running && (
                <Text>当前没有可用的后台执行额度，请保持 App 在前台。</Text>
              )}
              <View style={styles.actions}>
                <Button
                  testID="local-runtime-start"
                  mode="contained-tonal"
                  disabled={
                    busy || running || status.state === 'starting' || status.state === 'stopping'
                  }
                  loading={status.state === 'starting'}
                  onPress={() =>
                    void act(async () => {
                      await runtime.start()
                      await onChanged()
                    })
                  }
                >
                  启动本机执行
                </Button>
                <Button
                  testID="local-runtime-stop"
                  disabled={busy || !running}
                  onPress={() =>
                    void act(async () => {
                      await runtime.stop()
                      loginSession.reset()
                      setAccount(null)
                      await onChanged()
                    })
                  }
                >
                  停止
                </Button>
              </View>
            </>
          )}
          {running && section !== 'execution' && (
            <>
              <Text variant="bodySmall" testID="local-runtime-usage">
                返回聊天列表后新建会话，默认由这台手机执行。登录 Wegent
                后可以选择云设备；已有会话保留原来的执行设备。
              </Text>
              <Text variant="labelLarge">Codex 账号</Text>
              <Text>
                {account
                  ? [account.email || account.accountType, account.planType]
                      .filter(Boolean)
                      .join(' · ')
                  : '尚未登录；也可以添加自定义模型服务'}
              </Text>
              {accounts.length > 1 &&
                accounts.map(item => (
                  <Button
                    key={item.id}
                    testID={`codex-account-${item.id}`}
                    disabled={busy || Boolean(login) || item.id === account?.id}
                    onPress={() =>
                      void act(async () => {
                        const response = await runtime.request<{
                          activeAccountId: string | null
                          accounts: CodexAccount[]
                        }>('runtime.codex.accounts.switch', { accountId: item.id })
                        setAccounts(response.accounts)
                        setAccount(
                          response.accounts.find(
                            candidate => candidate.id === response.activeAccountId
                          ) ?? null
                        )
                        await onChanged()
                      })
                    }
                  >
                    {item.email || item.accountType}
                    {item.id === account?.id ? ' · 当前账号' : ''}
                  </Button>
                ))}
              {login ? (
                <>
                  {login.type === 'chatgptDeviceCode' ? (
                    <>
                      <Text selectable variant="headlineSmall" testID="codex-device-code">
                        {login.userCode}
                      </Text>
                      <Text variant="bodySmall">
                        设备码已复制。可能需要先在 ChatGPT 安全设置中启用设备码授权。
                      </Text>
                    </>
                  ) : (
                    <Text testID="codex-browser-pending">
                      请在浏览器中完成 OpenAI 授权，然后返回 App。
                    </Text>
                  )}
                  <View style={styles.actions}>
                    <Button
                      testID="codex-open-login"
                      onPress={() => void act(() => openLogin(login))}
                    >
                      打开登录页面
                    </Button>
                    <Button
                      testID="codex-cancel-login"
                      disabled={busy}
                      onPress={() => void act(() => loginSession.cancel())}
                    >
                      取消
                    </Button>
                  </View>
                </>
              ) : (
                <>
                  <Button
                    testID="codex-account-login"
                    disabled={busy}
                    loading={busy}
                    onPress={() => confirmModelDataSharing(() => act(() => startLogin('chatgpt')))}
                  >
                    {account ? '登录其他 OpenAI 账号' : '使用 OpenAI 账号登录'}
                  </Button>
                  <Button
                    testID="codex-device-login"
                    disabled={busy}
                    onPress={() =>
                      confirmModelDataSharing(() => act(() => startLogin('chatgptDeviceCode')))
                    }
                  >
                    使用设备码登录
                  </Button>
                </>
              )}
            </>
          )}
        </>
      )}
      {(error != null || loginState.error != null || status.error != null) && (
        <ErrorNotice
          error={error ?? loginState.error ?? status.error}
          testID="local-runtime-error"
        />
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: { gap: 10, paddingTop: 16 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
})
