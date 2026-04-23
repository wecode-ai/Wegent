'use client'

import dynamic from 'next/dynamic'

const AdminTransitionPageEdit = dynamic(
  () => import('@wecode/features/transition-pages/pages/AdminTransitionPageEdit'),
  { ssr: false }
)

export default function EditTransitionPage() {
  return <AdminTransitionPageEdit />
}
