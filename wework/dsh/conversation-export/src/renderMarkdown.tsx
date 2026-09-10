import { renderToStaticMarkup } from 'react-dom/server'
import Markdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'

const EMBEDDED_IMAGE_URL = /^data:image\/(?:bmp|gif|jpeg|png|webp);base64,/i

export function renderMarkdownHtml(content: string): string {
  return renderToStaticMarkup(
    <Markdown
      remarkPlugins={[remarkGfm]}
      urlTransform={url => (EMBEDDED_IMAGE_URL.test(url) ? url : defaultUrlTransform(url))}
    >
      {content}
    </Markdown>
  )
}
