'use client'

import dynamic from 'next/dynamic'

const TransitionPageView = dynamic(
  () => import('@wecode/features/transition-pages/pages/TransitionPageView'),
  { ssr: false }
)

export default function TransitionPage() {
  return <TransitionPageView />
}
