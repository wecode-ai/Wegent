import type { Metadata } from 'next'
import './globals.css'
import { Sidebar } from '@/components/common/sidebar'
import { Header } from '@/components/common/header'
import { Providers } from '@/components/providers'

export const metadata: Metadata = {
  title: 'Wegent Evaluate',
  description: 'RAG Evaluation Service',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen bg-background font-sans antialiased">
        <Providers>
          <div className="flex min-h-screen">
            <Sidebar />
            <div className="flex flex-1 flex-col">
              <Header />
              <main className="flex-1 p-6">{children}</main>
            </div>
          </div>
        </Providers>
      </body>
    </html>
  )
}
