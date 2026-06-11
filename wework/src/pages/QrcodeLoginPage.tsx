import { useCallback, useEffect, useState } from 'react'
import { QrCode, RefreshCw, Smartphone } from 'lucide-react'
import type { WeiboQrcodeChallenge } from '@/api/auth'
import { ApiError } from '@/api/http'
import { POST_LOGIN_REDIRECT_KEY } from '@/features/auth/redirect'
import { useAuth } from '@/features/auth/useAuth'
import { useTranslation } from '@/hooks/useTranslation'
import { navigateTo } from '@/lib/navigation'

const QRCODE_POLL_INTERVAL_MS = 2000
const POCKET_SCHEME = 'sinaintravdun'

interface QrcodeLoginPageProps {
  redirectTarget: string
}

function getQrcodeErrorMessage(err: unknown, fallback: string, unavailable: string) {
  if (err instanceof ApiError && err.status === 404) {
    return unavailable
  }
  return err instanceof Error ? err.message : fallback
}

export function QrcodeLoginPage({ redirectTarget }: QrcodeLoginPageProps) {
  const { t } = useTranslation('common')
  const { createWeiboQrcodeChallenge, loginWithWeiboQrcode } = useAuth()
  const [qrcodeChallenge, setQrcodeChallenge] =
    useState<WeiboQrcodeChallenge | null>(null)
  const [qrcodeStatus, setQrcodeStatus] = useState<
    'idle' | 'loading' | 'waiting' | 'expired' | 'error'
  >('idle')
  const [qrcodeError, setQrcodeError] = useState<string | null>(null)
  const [qrcodeNonce, setQrcodeNonce] = useState(0)
  const [pocketOpening, setPocketOpening] = useState(false)

  const openPocketApp = useCallback((qrData: string) => {
    setPocketOpening(true)
    // qr_data = https://koudai.sina.com/staffvdun/qr?d=<token>
    // Pocket app scheme expects only the token: sinaintravdun://qr?d=<token>
    let pocketUrl: string
    try {
      const token = new URL(qrData).searchParams.get('d')
      pocketUrl = token ? `${POCKET_SCHEME}://qr?d=${token}` : qrData
    } catch {
      pocketUrl = qrData
    }
    window.location.href = pocketUrl
    setTimeout(() => setPocketOpening(false), 3000)
  }, [])

  useEffect(() => {
    let isCancelled = false

    async function loadQrcode() {
      setQrcodeStatus('loading')
      setQrcodeError(null)
      setQrcodeChallenge(null)
      try {
        const challenge = await createWeiboQrcodeChallenge()
        if (isCancelled) return
        setQrcodeChallenge(challenge)
        setQrcodeStatus('waiting')
      } catch (err) {
        if (isCancelled) return
        setQrcodeError(
          getQrcodeErrorMessage(
            err,
            t('workbench.mobile_qrcode_failed'),
            t('workbench.mobile_qrcode_backend_unavailable'),
          ),
        )
        setQrcodeStatus('error')
      }
    }

    void Promise.resolve().then(() => loadQrcode())

    return () => {
      isCancelled = true
    }
  }, [createWeiboQrcodeChallenge, qrcodeNonce, t])

  useEffect(() => {
    if (!qrcodeChallenge || qrcodeStatus !== 'waiting') {
      return
    }

    let isCancelled = false
    const expiresAt = Date.now() + qrcodeChallenge.expires_in * 1000

    const poll = async () => {
      if (Date.now() >= expiresAt) {
        if (!isCancelled) {
          setQrcodeStatus('expired')
        }
        return
      }

      try {
        const loggedInUser = await loginWithWeiboQrcode(
          qrcodeChallenge.sid,
          qrcodeChallenge.qr_data,
        )
        if (!loggedInUser || isCancelled) return
        sessionStorage.removeItem(POST_LOGIN_REDIRECT_KEY)
        navigateTo(redirectTarget)
      } catch (err) {
        if (!isCancelled) {
          setQrcodeError(
            getQrcodeErrorMessage(
              err,
              t('workbench.mobile_qrcode_failed'),
              t('workbench.mobile_qrcode_backend_unavailable'),
            ),
          )
          setQrcodeStatus('error')
        }
      }
    }

    const interval = window.setInterval(() => {
      void poll()
    }, QRCODE_POLL_INTERVAL_MS)

    void poll()

    return () => {
      isCancelled = true
      window.clearInterval(interval)
    }
  }, [loginWithWeiboQrcode, qrcodeChallenge, qrcodeStatus, redirectTarget, t])

  function refreshQrcode() {
    setQrcodeNonce(current => current + 1)
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-base px-6 py-12">
      <main className="w-full max-w-sm text-center" data-testid="qrcode-login-page">
        <div className="mb-8">
          <h1 className="text-3xl font-semibold text-text-primary">
            {t('workbench.login_title', '登录 Wework')}
          </h1>
          <p className="mt-2 text-sm text-text-muted">
            {t('workbench.mobile_qrcode_login_description')}
          </p>
        </div>
        <section className="rounded-2xl border border-border bg-surface px-6 py-7 shadow-[0_16px_44px_rgba(0,0,0,0.08)]">
          <div className="mb-5 flex items-center justify-center gap-2 text-text-primary">
            <QrCode className="h-5 w-5" />
            <h2 className="text-lg font-semibold">
              {t('workbench.mobile_qrcode_login_title')}
            </h2>
          </div>
          <div className="mx-auto flex aspect-square w-full max-w-[240px] items-center justify-center rounded-lg border border-border bg-white p-3">
            {qrcodeChallenge && qrcodeStatus === 'waiting' ? (
              <img
                data-testid="mobile-weibo-qrcode-image"
                src={qrcodeChallenge.qr_code_image}
                alt={t('workbench.mobile_qrcode_alt')}
                className="h-full w-full"
              />
            ) : (
              <div className="px-3 text-sm text-text-muted">
                {qrcodeStatus === 'loading' && t('workbench.mobile_qrcode_loading')}
                {qrcodeStatus === 'expired' && t('workbench.mobile_qrcode_expired')}
                {qrcodeStatus === 'error' &&
                  (qrcodeError || t('workbench.mobile_qrcode_failed'))}
              </div>
            )}
          </div>
          <div className="mt-4 min-h-5 text-sm text-text-secondary">
            {qrcodeStatus === 'waiting' && t('workbench.mobile_qrcode_waiting')}
          </div>
          {qrcodeChallenge && qrcodeStatus === 'waiting' && (
            <button
              type="button"
              data-testid="pocket-login-button"
              className="mt-5 inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-text-primary px-4 text-sm font-semibold text-white shadow-sm disabled:opacity-60"
              disabled={pocketOpening}
              onClick={() => openPocketApp(qrcodeChallenge.qr_data)}
            >
              <Smartphone className="h-4 w-4" />
              {pocketOpening
                ? t('workbench.pocket_opening', '正在打开新浪口袋...')
                : t('workbench.pocket_login', '打开口袋登录')}
            </button>
          )}
          {(qrcodeStatus === 'expired' || qrcodeStatus === 'error') && (
            <button
              type="button"
              data-testid="refresh-mobile-weibo-qrcode-button"
              className="mt-4 inline-flex h-11 min-w-[44px] items-center justify-center gap-2 rounded-lg border border-border px-4 text-sm font-semibold text-text-primary"
              onClick={refreshQrcode}
            >
              <RefreshCw className="h-4 w-4" />
              {t('workbench.mobile_qrcode_refresh')}
            </button>
          )}
        </section>
      </main>
    </div>
  )
}
