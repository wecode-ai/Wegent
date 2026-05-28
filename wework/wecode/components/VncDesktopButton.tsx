import { Monitor } from 'lucide-react'
import { useCallback, useState } from 'react'
import { cloudDeviceInternalApis } from '@wecode/api/devices'

interface VncDesktopButtonProps {
  deviceId: string
}

export function VncDesktopButton({ deviceId }: VncDesktopButtonProps) {
  const [loading, setLoading] = useState(false)

  const handleClick = useCallback(async () => {
    if (loading) return
    setLoading(true)
    try {
      const config = await cloudDeviceInternalApis.getVncConfig(deviceId)
      const token = localStorage.getItem('auth_token') || ''
      const origin = window.location.origin
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const host = window.location.host
      const vncWsUrl = `${protocol}//${host}/api/cloud-devices/${encodeURIComponent(deviceId)}/vnc-ws?token=${encodeURIComponent(token)}`
      const vncPageUrl = `${origin}/vnc.html?wsUrl=${encodeURIComponent(vncWsUrl)}&sandboxId=${encodeURIComponent(config.sandbox_id)}`
      window.open(vncPageUrl, '_blank', 'noopener')
    } catch (e) {
      console.error('Failed to get VNC config:', e)
    } finally {
      setLoading(false)
    }
  }, [deviceId, loading])

  return (
    <button
      type="button"
      data-testid={`connection-vnc-button-${deviceId}`}
      onClick={handleClick}
      disabled={loading}
      className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#dedede] bg-white px-2.5 text-xs font-medium text-[#3c4043] hover:bg-[#f7f7f8] disabled:opacity-50"
    >
      <Monitor className="h-3.5 w-3.5" />
      <span>桌面</span>
    </button>
  )
}
