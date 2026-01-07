'use client'

import * as React from 'react'
import { Search, ChevronRight, ChevronLeft, GripVertical } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ScrollArea } from '@/components/ui/scroll-area'

export interface TransferItem {
  key: string
  title: string
  description?: string
  disabled?: boolean
}

export interface TransferProps {
  dataSource: TransferItem[]
  targetKeys: string[]
  onChange: (targetKeys: string[], direction: 'left' | 'right', moveKeys: string[]) => void
  onOrderChange?: (newOrder: string[]) => void
  render?: (item: TransferItem) => React.ReactNode
  showSearch?: boolean
  filterOption?: (inputValue: string, item: TransferItem) => boolean
  titles?: [string, string]
  className?: string
  listStyle?: React.CSSProperties
  operations?: [string, string]
  leftFooter?: React.ReactNode
  rightFooter?: React.ReactNode
  disabled?: boolean
  sortable?: boolean
}

export function Transfer({
  dataSource,
  targetKeys,
  onChange,
  onOrderChange,
  render,
  showSearch = false,
  filterOption,
  titles = ['Source', 'Target'],
  className,
  listStyle,
  operations = ['>', '<'],
  leftFooter,
  rightFooter,
  disabled = false,
  sortable = false,
}: TransferProps) {
  const [leftSearch, setLeftSearch] = React.useState('')
  const [rightSearch, setRightSearch] = React.useState('')
  const [leftChecked, setLeftChecked] = React.useState<string[]>([])
  const [rightChecked, setRightChecked] = React.useState<string[]>([])
  const [draggedKey, setDraggedKey] = React.useState<string | null>(null)
  const [dragOverKey, setDragOverKey] = React.useState<string | null>(null)

  // 分离左右两侧的数据
  const leftDataSource = React.useMemo(
    () => dataSource.filter(item => !targetKeys.includes(item.key)),
    [dataSource, targetKeys]
  )

  const rightDataSource = React.useMemo(() => {
    const targetSet = new Set(targetKeys)
    const itemMap = new Map(dataSource.map(item => [item.key, item]))
    return targetKeys
      .filter(key => targetSet.has(key) && itemMap.has(key))
      .map(key => itemMap.get(key)!)
  }, [dataSource, targetKeys])

  // 过滤函数
  const defaultFilterOption = (inputValue: string, item: TransferItem) => {
    return item.title.toLowerCase().includes(inputValue.toLowerCase())
  }

  const filter = filterOption || defaultFilterOption

  // 过滤后的数据
  const filteredLeftData = React.useMemo(
    () => leftDataSource.filter(item => filter(leftSearch, item)),
    [leftDataSource, leftSearch, filter]
  )

  const filteredRightData = React.useMemo(
    () => rightDataSource.filter(item => filter(rightSearch, item)),
    [rightDataSource, rightSearch, filter]
  )

  // 移动到右侧
  const moveToRight = () => {
    const newTargetKeys = [...targetKeys, ...leftChecked]
    onChange(newTargetKeys, 'right', leftChecked)
    setLeftChecked([])
  }

  // 移动到左侧
  const moveToLeft = () => {
    const newTargetKeys = targetKeys.filter(key => !rightChecked.includes(key))
    onChange(newTargetKeys, 'left', rightChecked)
    setRightChecked([])
  }

  // 渲染列表项
  const renderItem = (item: TransferItem) => {
    if (render) {
      return render(item)
    }
    return (
      <div className="flex flex-col">
        <span className="text-sm">{item.title}</span>
        {item.description && (
          <span className="text-xs text-muted-foreground">{item.description}</span>
        )}
      </div>
    )
  }
  // 拖拽处理函数
  const handleDragStart = (e: React.DragEvent, key: string) => {
    setDraggedKey(key)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', key)
  }

  const handleDragOver = (e: React.DragEvent, key: string) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (draggedKey && key !== draggedKey) {
      setDragOverKey(key)
    }
  }

  const handleDragLeave = () => {
    setDragOverKey(null)
  }

  const handleDrop = (e: React.DragEvent, targetKey: string) => {
    e.preventDefault()
    if (!draggedKey || draggedKey === targetKey) {
      setDraggedKey(null)
      setDragOverKey(null)
      return
    }

    const currentOrder = [...targetKeys]
    const draggedIndex = currentOrder.indexOf(draggedKey)
    const targetIndex = currentOrder.indexOf(targetKey)

    if (draggedIndex === -1 || targetIndex === -1) {
      setDraggedKey(null)
      setDragOverKey(null)
      return
    }

    // 移除拖拽项并插入到目标位置
    currentOrder.splice(draggedIndex, 1)
    currentOrder.splice(targetIndex, 0, draggedKey)

    if (onOrderChange) {
      onOrderChange(currentOrder)
    }

    setDraggedKey(null)
    setDragOverKey(null)
  }

  const handleDragEnd = () => {
    setDraggedKey(null)
    setDragOverKey(null)
  }

  // 渲染列表
  const renderList = (
    data: TransferItem[],
    checked: string[],
    setChecked: React.Dispatch<React.SetStateAction<string[]>>,
    search: string,
    setSearch: React.Dispatch<React.SetStateAction<string>>,
    title: string,
    footer?: React.ReactNode,
    isRightList?: boolean
  ) => {
    const allKeys = data.filter(item => !item.disabled).map(item => item.key)
    const checkedAll = allKeys.length > 0 && allKeys.every(key => checked.includes(key))
    const indeterminate = checked.length > 0 && !checkedAll
    const mergedListStyle: React.CSSProperties = {
      borderColor: 'rgb(var(--color-border))',
      backgroundColor: 'rgb(var(--color-bg-surface))',
      ...listStyle,
    }

    const handleCheckAll = () => {
      if (checkedAll) {
        setChecked([])
      } else {
        setChecked(allKeys)
      }
    }

    const handleCheck = (key: string) => {
      setChecked(prev => (prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]))
    }

    return (
      <div
        className="flex flex-col border border-border rounded-md h-full bg-surface"
        style={mergedListStyle}
      >
        {/* 标题栏 */}
        <div className="flex items-center gap-2 p-3 border-b border-border bg-surface">
          <Checkbox
            checked={checkedAll}
            onCheckedChange={handleCheckAll}
            disabled={allKeys.length === 0}
            className={indeterminate ? 'data-[state=checked]:bg-primary' : ''}
          />
          <span className="text-sm font-medium flex-1">
            {title} ({checked.length}/{data.length})
          </span>
        </div>

        {/* 搜索框 */}
        {showSearch && (
          <div className="p-2 border-b border-border">
            <div className="relative">
              <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="pl-8 h-9"
              />
            </div>
          </div>
        )}

        {/* 列表 */}
        <ScrollArea className="flex-1 min-h-0">
          <div className="p-2 space-y-1">
            {data.length === 0 ? (
              <div className="text-center text-sm text-muted-foreground py-8">No data</div>
            ) : (
              data.map(item => {
                const isDragging = draggedKey === item.key
                const isDragOver = dragOverKey === item.key
                const canDrag = sortable && isRightList && !item.disabled

                return (
                  <div
                    key={item.key}
                    className={cn(
                      'flex items-center gap-2 p-2 rounded-md hover:bg-accent cursor-pointer transition-colors',
                      item.disabled && 'opacity-50 cursor-not-allowed',
                      isDragging && 'opacity-50 bg-accent',
                      isDragOver && 'border-t-2 border-primary'
                    )}
                    onClick={() => !item.disabled && handleCheck(item.key)}
                    draggable={canDrag}
                    onDragStart={canDrag ? e => handleDragStart(e, item.key) : undefined}
                    onDragOver={canDrag ? e => handleDragOver(e, item.key) : undefined}
                    onDragLeave={canDrag ? handleDragLeave : undefined}
                    onDrop={canDrag ? e => handleDrop(e, item.key) : undefined}
                    onDragEnd={canDrag ? handleDragEnd : undefined}
                  >
                    {canDrag && (
                      <GripVertical className="h-4 w-4 text-muted-foreground cursor-grab flex-shrink-0" />
                    )}
                    <Checkbox
                      checked={checked.includes(item.key)}
                      disabled={item.disabled}
                      onCheckedChange={() => {
                        handleCheck(item.key)
                      }}
                      onClick={e => e.stopPropagation()}
                    />
                    <div className="flex-1 min-w-0">{renderItem(item)}</div>
                  </div>
                )
              })
            )}
          </div>
        </ScrollArea>

        {/* Footer */}
        {footer && <div className="p-2 border-t border-border">{footer}</div>}
      </div>
    )
  }

  return (
    <div className={cn('flex items-stretch gap-4', className)}>
      {/* 左侧列表 */}
      <div className={cn('flex-1 flex flex-col', disabled && 'opacity-50 pointer-events-none')}>
        {renderList(
          filteredLeftData,
          leftChecked,
          setLeftChecked,
          leftSearch,
          setLeftSearch,
          titles[0],
          leftFooter
        )}
      </div>

      {/* 中间按钮 */}
      <div className="flex flex-col gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={moveToRight}
          disabled={disabled || leftChecked.length === 0}
          className="h-8 w-8 p-0"
        >
          {operations[0] === '>' ? <ChevronRight className="h-4 w-4" /> : operations[0]}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={moveToLeft}
          disabled={disabled || rightChecked.length === 0}
          className="h-8 w-8 p-0"
        >
          {operations[1] === '<' ? <ChevronLeft className="h-4 w-4" /> : operations[1]}
        </Button>
      </div>

      {/* 右侧列表 */}
      <div className={cn('flex-1 flex flex-col', disabled && 'opacity-50 pointer-events-none')}>
        {renderList(
          filteredRightData,
          rightChecked,
          setRightChecked,
          rightSearch,
          setRightSearch,
          titles[1],
          rightFooter,
          true
        )}
      </div>
    </div>
  )
}
