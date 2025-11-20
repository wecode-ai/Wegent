import { Button } from 'antd';
import { PlusIcon } from '@heroicons/react/24/outline';
import { ReactNode, CSSProperties } from 'react';

interface UnifiedAddButtonProps {
  onClick: () => void;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  icon?: ReactNode;
}

export default function UnifiedAddButton({
  onClick,
  children,
  className = '',
  style,
  icon,
}: UnifiedAddButtonProps) {
  return (
    <Button
      onClick={onClick}
      type="primary"
      size="small"
      icon={icon || <PlusIcon className="h-4 w-4 align-middle" />}
      style={{ margin: '8px 0', ...style }}
      className={`!text-base flex items-center justify-center gap-1 ${className}`}
    >
      {children}
    </Button>
  );
}
