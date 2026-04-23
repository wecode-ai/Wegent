'use client'

import dynamic from 'next/dynamic'

const AdminTransitionPageList = dynamic(
  () => import('@wecode/features/transition-pages/pages/AdminTransitionPageList'),
  { ssr: false }
)

export default function TransitionPagesPage() {
  return <AdminTransitionPageList />
}
