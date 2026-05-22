import { useState } from 'react'
import { useIsDesktop } from '@/hooks/useIsDesktop'
import { Header } from './Header'
import { Sidebar } from './Sidebar'

interface AppLayoutProps {
  children: React.ReactNode
}

export function AppLayout({ children }: AppLayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const isDesktop = useIsDesktop()

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-base">
      <Header onMenuClick={isDesktop ? undefined : () => setSidebarOpen(true)} />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          isOpen={isDesktop || sidebarOpen}
          onClose={() => setSidebarOpen(false)}
        />
        <main className="flex-1 overflow-auto p-4 lg:p-6">
          {children}
        </main>
      </div>
    </div>
  )
}
