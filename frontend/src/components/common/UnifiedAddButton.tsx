import { Button } from '@/components/ui/button'
import { PlusIcon } from '@heroicons/react/24/outline'
import { ReactNode } from 'react'

interface UnifiedAddButtonProps {
  onClick: () => void
  children: ReactNode
  className?: string
  icon?: ReactNode
  variant?: 'default' | 'primary' | 'outline' | 'secondary'
  [key: `data-${string}`]: string | undefined
}

export default function UnifiedAddButton({
  onClick,
  children,
  className = '',
  icon,
  variant = 'default',
  ...dataAttributes
}: UnifiedAddButtonProps) {
  return (
    <Button
      onClick={onClick}
      variant={variant}
      size="sm"
      className={`flex items-center gap-2 ${className}`}
      {...dataAttributes}
    >
      {icon || <PlusIcon className="h-4 w-4" />}
      {children}
    </Button>
  )
}
