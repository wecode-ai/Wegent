'use client'

import dynamic from 'next/dynamic'
import { UserProvider } from '@/features/common/UserContext'

const TransitionPageView = dynamic(
  () => import('@wecode/features/transition-pages/pages/TransitionPageView'),
  { ssr: false }
)

export default function TransitionPage() {
  return (
    <UserProvider>
      <TransitionPageView />
    </UserProvider>
  )
}
