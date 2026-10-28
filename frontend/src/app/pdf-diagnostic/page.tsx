'use client'

import dynamic from 'next/dynamic'
import { useState } from 'react'

const Preview = dynamic(
  () =>
    import('@/components/common/FilePreview/preview-renderers/FlyfishOfficePreview').then(
      m => m.FlyfishOfficePreview
    ),
  { ssr: false }
)

export default function PdfDiagnostic() {
  const [url, setUrl] = useState('')
  const [source, setSource] = useState('')
  const [error, setError] = useState('')
  return (
    <main>
      <input
        aria-label="PDF URL"
        type="password"
        value={url}
        onChange={e => setUrl(e.target.value)}
      />
      <button
        onClick={() => {
          setError('')
          setSource(url)
        }}
      >
        Preview
      </button>
      <pre role="status">{error}</pre>
      <div style={{ height: '75vh', position: 'relative' }}>
        {source && (
          <Preview
            url={source}
            filename="sample.pdf"
            restricted
            onError={e => setError(e.message.replace(/https?:\/\/\S+/g, '[URL]'))}
          />
        )}
      </div>
    </main>
  )
}
