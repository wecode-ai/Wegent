// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useCallback, useMemo } from 'react'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  Plus,
  Trash2,
  GripVertical,
  ChevronDown,
  ChevronRight,
  Star,
  AlertCircle,
  Eye,
  EyeOff,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useTranslation } from '@/hooks/useTranslation'
import type { AnswerSlot, SlotInputMode } from '@wecode/types/evaluation-exam'
import { Icon, type IconName } from '../exam/ExamIcons'
import { IconSelector } from '../exam/IconSelector'
import { SlotMarkdownContent } from '../exam/SlotMarkdownContent'

/**
 * Props for the SlotConfigEditor component
 */
interface SlotConfigEditorProps {
  /** Current slots configuration */
  slots: AnswerSlot[]
  /** Callback when slots change */
  onChange: (slots: AnswerSlot[]) => void
  /** Whether the editor is disabled */
  disabled?: boolean
}

/**
 * Validate slot key - must contain only alphanumeric characters [a-zA-Z0-9]
 * as it will be used in S3 paths.
 */
function isValidSlotKey(key: string): boolean {
  return /^[a-zA-Z0-9]+$/.test(key)
}

/**
 * Sanitize a string to be a valid slot key by removing non-alphanumeric characters
 */
function sanitizeSlotKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9]/g, '')
}

/**
 * Generate a unique stable ID for a slot
 */
function generateStableId(): string {
  return `slot_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
}

/**
 * Ensure slot has a stable _id
 */
function ensureSlotId(slot: AnswerSlot): AnswerSlot {
  if (!slot._id) {
    return { ...slot, _id: generateStableId() }
  }
  return slot
}

/**
 * Generate a unique slot key
 */
function generateSlotKey(existingKeys: Set<string>, prefix = 'slot'): string {
  let index = 1
  while (existingKeys.has(`${prefix}${index}`)) {
    index++
  }
  return `${prefix}${index}`
}

/**
 * Create a default normal slot
 */
function createDefaultSlot(existingKeys: Set<string>): AnswerSlot {
  return {
    _id: generateStableId(),
    key: generateSlotKey(existingKeys),
    label: '',
    icon: 'file',
    inputMode: 'attachment',
    required: false,
    hint: '',
    maxFiles: 10,
    accept: '.pdf,.doc,.docx,.txt,.md,.png,.jpg,.jpeg,.gif,.webp',
    isBonus: false,
  }
}

/**
 * Create a default bonus slot
 */
function createBonusSlot(existingKeys: Set<string>): AnswerSlot {
  return {
    _id: generateStableId(),
    key: generateSlotKey(existingKeys, 'bonus'),
    label: '',
    icon: 'sparkle',
    inputMode: 'link+attachment',
    required: false,
    hint: '',
    maxFiles: 10,
    accept: '.pdf,.doc,.docx,.pptx,.png,.jpg,.jpeg,.gif,.webp,.mp4,.mov',
    isBonus: true,
    title: '',
    contentMarkdown: '',
  }
}

/**
 * Input mode options
 */
const INPUT_MODE_OPTIONS: { value: SlotInputMode; labelKey: string }[] = [
  { value: 'attachment', labelKey: 'slots.input_mode.attachment' },
  { value: 'text', labelKey: 'slots.input_mode.text' },
  { value: 'link+attachment', labelKey: 'slots.input_mode.link_attachment' },
  { value: 'link_or_attachment', labelKey: 'slots.input_mode.link_or_attachment' },
]

/**
 * Sortable slot item component
 */
interface SlotItemProps {
  slot: AnswerSlot
  index: number
  isExpanded: boolean
  onToggleExpand: () => void
  onUpdate: (updates: Partial<AnswerSlot>) => void
  onDelete: () => void
  disabled?: boolean
  validationError?: string
}

function SlotItem({
  slot,
  index,
  isExpanded,
  onToggleExpand,
  onUpdate,
  onDelete,
  disabled,
  validationError,
}: SlotItemProps) {
  const { t } = useTranslation('evaluation')
  const [showHintPreview, setShowHintPreview] = useState(false)
  // Use stable _id for sortable, not the mutable key
  const stableId = slot._id || slot.key
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: stableId,
    disabled,
  })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`bg-white rounded-xl border ${validationError ? 'border-red-300' : 'border-gray-100'} shadow-sm ${isDragging ? 'opacity-50 shadow-lg' : ''}`}
    >
      {/* Header - always visible */}
      <div
        className="flex items-center gap-3 p-4 cursor-pointer"
        onClick={onToggleExpand}
        data-testid={`slot-header-${index}`}
      >
        {/* Drag handle */}
        <button
          className="cursor-grab text-gray-400 hover:text-gray-600 touch-none"
          {...attributes}
          {...listeners}
          onClick={e => e.stopPropagation()}
          disabled={disabled}
          data-testid={`slot-drag-handle-${index}`}
        >
          <GripVertical className="w-5 h-5" />
        </button>

        {/* Icon */}
        <div className="w-8 h-8 rounded-lg bg-red-50 flex items-center justify-center shrink-0">
          <Icon name={slot.icon as IconName} size={18} className="text-[#DF2029]" />
        </div>

        {/* Label and badges */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-gray-900 truncate">
              {slot.label || t('slots.unnamed_slot')}
            </span>
            {slot.isBonus && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 text-xs font-medium">
                <Star className="w-3 h-3" />
                {t('slots.bonus')}
              </span>
            )}
            {slot.required && (
              <span className="px-2 py-0.5 rounded-full bg-red-100 text-red-700 text-xs font-medium">
                {t('slots.required')}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-xs text-gray-500 bg-gray-100 px-2 py-0.5 rounded">
              {t(`slots.input_mode.${slot.inputMode.replace('+', '_')}`)}
            </span>
            <span className="text-xs text-gray-400">key: {slot.key}</span>
          </div>
        </div>

        {/* Validation error indicator */}
        {validationError && (
          <div className="text-red-500" title={validationError}>
            <AlertCircle className="w-5 h-5" />
          </div>
        )}

        {/* Delete button */}
        <button
          className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
          onClick={e => {
            e.stopPropagation()
            onDelete()
          }}
          disabled={disabled}
          data-testid={`slot-delete-${index}`}
        >
          <Trash2 className="w-4 h-4" />
        </button>

        {/* Expand/collapse indicator */}
        {isExpanded ? (
          <ChevronDown className="w-5 h-5 text-gray-400" />
        ) : (
          <ChevronRight className="w-5 h-5 text-gray-400" />
        )}
      </div>

      {/* Expanded content */}
      {isExpanded && (
        <div className="px-4 pb-4 pt-0 border-t border-gray-100 space-y-4">
          {/* Validation error message */}
          {validationError && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
              {validationError}
            </div>
          )}

          {/* Basic fields */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-4">
            {/* Key (read-only display) */}
            <div className="space-y-2">
              <Label>{t('slots.key')}</Label>
              <Input
                value={slot.key}
                onChange={e => onUpdate({ key: e.target.value })}
                disabled={disabled}
                placeholder={t('slots.key_placeholder')}
                data-testid={`slot-key-${index}`}
              />
            </div>

            {/* Label */}
            <div className="space-y-2">
              <Label>{t('slots.label')}</Label>
              <Input
                value={slot.label}
                onChange={e => onUpdate({ label: e.target.value })}
                disabled={disabled}
                placeholder={t('slots.label_placeholder')}
                data-testid={`slot-label-${index}`}
              />
            </div>

            {/* Icon selector */}
            <div className="space-y-2">
              <Label>{t('slots.icon')}</Label>
              <IconSelector
                value={slot.icon as IconName}
                onChange={(icon: IconName) => onUpdate({ icon })}
                disabled={disabled}
              />
            </div>

            {/* Input mode */}
            <div className="space-y-2">
              <Label>{t('slots.input_mode.label')}</Label>
              <Select
                value={slot.inputMode}
                onValueChange={(value: SlotInputMode) => onUpdate({ inputMode: value })}
                disabled={disabled}
              >
                <SelectTrigger data-testid={`slot-input-mode-${index}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {INPUT_MODE_OPTIONS.map(opt => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {t(opt.labelKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Required switch */}
          <div className="flex items-center justify-between">
            <div>
              <Label>{t('slots.required')}</Label>
              <p className="text-xs text-gray-500">{t('slots.required_hint')}</p>
            </div>
            <Switch
              checked={slot.required}
              onCheckedChange={required => onUpdate({ required })}
              disabled={disabled}
              data-testid={`slot-required-${index}`}
            />
          </div>

          {/* Hint with Markdown preview */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>{t('slots.hint')}</Label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setShowHintPreview(!showHintPreview)}
                className="h-7 px-2 text-gray-500 hover:text-gray-700"
              >
                {showHintPreview ? (
                  <>
                    <EyeOff className="w-4 h-4 mr-1" />
                    {t('common:actions.edit')}
                  </>
                ) : (
                  <>
                    <Eye className="w-4 h-4 mr-1" />
                    {t('slots.preview')}
                  </>
                )}
              </Button>
            </div>
            {showHintPreview ? (
              <div className="min-h-[80px] prose prose-sm max-w-none">
                {slot.hint ? (
                  <SlotMarkdownContent content={slot.hint} />
                ) : (
                  <p className="text-gray-400 italic">{t('slots.no_content')}</p>
                )}
              </div>
            ) : (
              <Textarea
                value={slot.hint || ''}
                onChange={e => onUpdate({ hint: e.target.value })}
                disabled={disabled}
                placeholder={t('slots.hint_placeholder')}
                rows={3}
                className="resize-y"
                data-testid={`slot-hint-${index}`}
              />
            )}
            <p className="text-xs text-gray-500">{t('slots.hint_markdown_support')}</p>
          </div>

          {/* File settings - only shown for attachment input modes */}
          {(slot.inputMode === 'attachment' || slot.inputMode === 'link+attachment' || slot.inputMode === 'link_or_attachment') && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-4 bg-gray-50 rounded-lg">
              <div className="space-y-2">
                <Label>{t('slots.max_files')}</Label>
                <Input
                  type="number"
                  min={1}
                  max={100}
                  value={slot.maxFiles ?? 10}
                  onChange={e => onUpdate({ maxFiles: parseInt(e.target.value) || 10 })}
                  disabled={disabled}
                  data-testid={`slot-max-files-${index}`}
                />
              </div>
              <div className="space-y-2">
                <Label>{t('slots.accept')}</Label>
                <Input
                  value={slot.accept || ''}
                  onChange={e => onUpdate({ accept: e.target.value })}
                  disabled={disabled}
                  placeholder=".pdf,.doc,.docx"
                  data-testid={`slot-accept-${index}`}
                />
                <p className="text-xs text-gray-500">{t('slots.accept_hint')}</p>
              </div>
            </div>
          )}

          {/* Bonus fields - only shown for bonus slots */}
          {slot.isBonus && (
            <div className="space-y-4 p-4 bg-amber-50 border border-amber-200 rounded-lg">
              <h4 className="font-medium text-amber-800 flex items-center gap-2">
                <Star className="w-4 h-4" />
                {t('slots.bonus_config')}
              </h4>
              <div className="space-y-2">
                <Label>{t('slots.bonus_title')}</Label>
                <Input
                  value={slot.title || ''}
                  onChange={e => onUpdate({ title: e.target.value })}
                  disabled={disabled}
                  placeholder={t('slots.bonus_title_placeholder')}
                  data-testid={`slot-bonus-title-${index}`}
                />
              </div>
              <div className="space-y-2">
                <Label>{t('slots.bonus_content')}</Label>
                <Textarea
                  value={slot.contentMarkdown || ''}
                  onChange={e => onUpdate({ contentMarkdown: e.target.value })}
                  disabled={disabled}
                  placeholder={t('slots.bonus_content_placeholder')}
                  rows={4}
                  data-testid={`slot-bonus-content-${index}`}
                />
                <p className="text-xs text-gray-500">{t('slots.bonus_content_hint')}</p>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * SlotConfigEditor - Visual editor for configuring answer slots
 *
 * Features:
 * - Drag-and-drop reordering using @dnd-kit
 * - Click to expand/collapse slot details
 * - Add new slot (normal or bonus)
 * - Delete slot with confirmation
 * - Edit all slot fields inline
 * - Icon selector
 * - Input mode selector
 * - Validation: unique keys, required fields for bonus
 */
export function SlotConfigEditor({ slots, onChange, disabled }: SlotConfigEditorProps) {
  const { t } = useTranslation('evaluation')
  const [expandedSlots, setExpandedSlots] = useState<Set<string>>(new Set())
  const [deleteConfirmSlot, setDeleteConfirmSlot] = useState<string | null>(null)

  // Ensure all slots have stable _id
  const slotsWithIds = useMemo(() => slots.map(ensureSlotId), [slots])

  // Sync slots with _id back to parent if any were missing
  useMemo(() => {
    const needsUpdate = slots.some((s, i) => !s._id && slotsWithIds[i]._id)
    if (needsUpdate) {
      onChange(slotsWithIds)
    }
  }, [slots, slotsWithIds, onChange])

  // Get existing keys for validation
  const existingKeys = useMemo(() => new Set(slotsWithIds.map(s => s.key)), [slotsWithIds])

  // Validate slots - use _id for error keys
  const validationErrors = useMemo(() => {
    const errors: Record<string, string> = {}
    const keyCount: Record<string, number> = {}

    // Check for duplicate keys
    slotsWithIds.forEach(slot => {
      keyCount[slot.key] = (keyCount[slot.key] || 0) + 1
    })

    slotsWithIds.forEach(slot => {
      const slotErrors: string[] = []
      const slotId = slot._id || slot.key

      // Duplicate key
      if (keyCount[slot.key] > 1) {
        slotErrors.push(t('slots.validation.duplicate_key'))
      }

      // Empty key
      if (!slot.key.trim()) {
        slotErrors.push(t('slots.validation.empty_key'))
      }

      // Invalid key format (must be alphanumeric only)
      if (slot.key.trim() && !isValidSlotKey(slot.key)) {
        slotErrors.push(t('slots.validation.invalid_key_format'))
      }

      // Empty label
      if (!slot.label.trim()) {
        slotErrors.push(t('slots.validation.empty_label'))
      }

      // Bonus slot must have title
      if (slot.isBonus && !slot.title?.trim()) {
        slotErrors.push(t('slots.validation.bonus_requires_title'))
      }

      if (slotErrors.length > 0) {
        errors[slotId] = slotErrors.join('; ')
      }
    })

    return errors
  }, [slotsWithIds, t])

  // Configure sensors for drag-and-drop
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: 200,
        tolerance: 5,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  )

  // Handle drag end - reorder slots using _id
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event

      if (!over || active.id === over.id) {
        return
      }

      const oldIndex = slotsWithIds.findIndex(s => (s._id || s.key) === active.id)
      const newIndex = slotsWithIds.findIndex(s => (s._id || s.key) === over.id)

      if (oldIndex === -1 || newIndex === -1) {
        return
      }

      onChange(arrayMove(slotsWithIds, oldIndex, newIndex))
    },
    [slotsWithIds, onChange]
  )

  // Toggle slot expansion using _id
  const toggleSlotExpand = useCallback((id: string) => {
    setExpandedSlots(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }, [])

  // Add new slot
  const handleAddSlot = useCallback(
    (isBonus: boolean) => {
      const newSlot = isBonus ? createBonusSlot(existingKeys) : createDefaultSlot(existingKeys)
      onChange([...slotsWithIds, newSlot])
      // Auto-expand the new slot using _id
      setExpandedSlots(prev => new Set(prev).add(newSlot._id!))
    },
    [slotsWithIds, onChange, existingKeys]
  )

  // Update slot using _id
  const handleUpdateSlot = useCallback(
    (id: string, updates: Partial<AnswerSlot>) => {
      // Auto-sanitize the key if it's being updated
      if (updates.key !== undefined) {
        updates.key = sanitizeSlotKey(updates.key)
      }
      onChange(slotsWithIds.map(s => ((s._id || s.key) === id ? { ...s, ...updates } : s)))
    },
    [slotsWithIds, onChange]
  )

  // Delete slot using _id
  const handleDeleteSlot = useCallback(
    (id: string) => {
      onChange(slotsWithIds.filter(s => (s._id || s.key) !== id))
      setExpandedSlots(prev => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      setDeleteConfirmSlot(null)
    },
    [slotsWithIds, onChange]
  )

  return (
    <div className="space-y-4">
      {/* Header with add button */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-medium text-gray-900">{t('slots.title')}</h3>
          <p className="text-sm text-gray-500">{t('slots.description')}</p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              className="bg-[#DF2029] hover:bg-[#c81d25] text-white"
              disabled={disabled}
              data-testid="add-slot-button"
            >
              <Plus className="w-4 h-4 mr-2" />
              {t('slots.add_slot')}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => handleAddSlot(false)} data-testid="add-normal-slot">
              <Plus className="w-4 h-4 mr-2" />
              {t('slots.add_normal_slot')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => handleAddSlot(true)} data-testid="add-bonus-slot">
              <Star className="w-4 h-4 mr-2 text-amber-500" />
              {t('slots.add_bonus_slot')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Empty state */}
      {slots.length === 0 && (
        <div className="bg-white rounded-2xl border border-gray-100 border-dashed p-8 text-center">
          <div className="w-12 h-12 rounded-xl bg-gray-50 flex items-center justify-center mx-auto mb-3">
            <Plus className="w-6 h-6 text-gray-400" />
          </div>
          <h4 className="font-medium text-gray-900 mb-1">{t('slots.no_slots')}</h4>
          <p className="text-sm text-gray-500 mb-4">{t('slots.no_slots_hint')}</p>
          <Button
            variant="outline"
            onClick={() => handleAddSlot(false)}
            disabled={disabled}
            data-testid="add-first-slot"
          >
            <Plus className="w-4 h-4 mr-2" />
            {t('slots.add_first_slot')}
          </Button>
        </div>
      )}

      {/* Slots list */}
      {slotsWithIds.length > 0 && (
        <>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={slotsWithIds.map(s => s._id || s.key)}
              strategy={verticalListSortingStrategy}
            >
              <div className="space-y-3">
                {slotsWithIds.map((slot, index) => {
                  const slotId = slot._id || slot.key
                  return (
                    <SlotItem
                      key={slotId}
                      slot={slot}
                      index={index}
                      isExpanded={expandedSlots.has(slotId)}
                      onToggleExpand={() => toggleSlotExpand(slotId)}
                      onUpdate={updates => handleUpdateSlot(slotId, updates)}
                      onDelete={() => setDeleteConfirmSlot(slotId)}
                      disabled={disabled}
                      validationError={validationErrors[slotId]}
                    />
                  )
                })}
              </div>
            </SortableContext>
          </DndContext>

          {/* Drag hint */}
          <p className="text-xs text-gray-400 text-center">{t('slots.drag_hint')}</p>
        </>
      )}

      {/* Delete confirmation dialog */}
      <AlertDialog open={!!deleteConfirmSlot} onOpenChange={() => setDeleteConfirmSlot(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('slots.delete_title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('slots.delete_description')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-500 hover:bg-red-600"
              onClick={() => deleteConfirmSlot && handleDeleteSlot(deleteConfirmSlot)}
            >
              {t('common:actions.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export default SlotConfigEditor
