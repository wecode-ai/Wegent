import { Bot } from 'lucide-react'
import type { ReactNode } from 'react'

interface HomeProps {
  heading: ReactNode
}

export default function FocusHome({ heading }: HomeProps) {
  return (
    <div
      data-testid="focus-home"
      className="mx-auto flex w-[min(46rem,calc(100%_-_2rem))] min-w-0 flex-col items-center"
    >
      <Bot className="mb-5 h-9 w-9 text-text-muted/55" aria-hidden="true" />
      {heading}
    </div>
  )
}
