'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useTranslation } from 'react-i18next'
import {
  LayoutDashboard,
  FileSearch,
  TrendingUp,
  GitCompare,
  AlertCircle,
  Settings,
  BookOpen,
} from 'lucide-react'

const navItems = [
  { href: '/', labelKey: 'nav.dashboard', icon: LayoutDashboard },
  { href: '/results', labelKey: 'nav.results', icon: FileSearch },
  { href: '/trends', labelKey: 'nav.trends', icon: TrendingUp },
  { href: '/comparison', labelKey: 'nav.comparison', icon: GitCompare },
  { href: '/issues', labelKey: 'nav.issues', icon: AlertCircle },
  { href: '/metrics-docs', labelKey: 'nav.metricsDocs', icon: BookOpen },
  { href: '/settings', labelKey: 'nav.settings', icon: Settings },
]

export function Sidebar() {
  const pathname = usePathname()
  const { t } = useTranslation()

  return (
    <aside className="flex w-64 flex-col border-r bg-card">
      <div className="flex h-14 items-center border-b px-4">
        <h1 className="text-lg font-semibold text-primary">Wegent Evaluate</h1>
      </div>
      <nav className="flex-1 space-y-1 p-2">
        {navItems.map((item) => {
          const isActive = pathname === item.href
          const Icon = item.icon
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
                isActive
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
              }`}
            >
              <Icon className="h-4 w-4" />
              {t(item.labelKey)}
            </Link>
          )
        })}
      </nav>
    </aside>
  )
}
