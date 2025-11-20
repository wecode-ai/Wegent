import { Button } from '@/components/ui/button';
import { PlusIcon } from '@heroicons/react/24/outline';
import { ReactNode } from 'react';

interface UnifiedAddButtonProps {
  onClick: () => void;
  children: ReactNode;
  className?: string;
  icon?: ReactNode;
}

export default function UnifiedAddButton({
  onClick,
  children,
  className,
  icon,
}: UnifiedAddButtonProps) {
  return (
    <Button onClick={onClick} variant="default" size="sm" className={className}>
      {icon || <PlusIcon className="h-4 w-4" />}
      {children}
    </Button>
  );
}
