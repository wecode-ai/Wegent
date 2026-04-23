'use client'

import { useEffect, useState } from 'react'
import { useRouter, useParams } from 'next/navigation'
import * as XLSX from 'xlsx'
import {
  ArrowLeft,
  Plus,
  Trash2,
  Users,
  Layout,
  Settings,
  Upload,
  Download,
  UserPlus,
  ArrowUp,
  ArrowDown,
  FileSpreadsheet,
  Eye,
  Loader2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/hooks/use-toast'
import { getToken } from '@/apis/user'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Checkbox } from '@/components/ui/checkbox'

interface TransitionPageDetail {
  page_id: string
  slug: string
  title: string
  title_font_size?: string
  status: string
  groups: Array<{
    key: string
    name: string
    start_at?: string
    end_at?: string
  }>
  block_groups: Array<{
    key: string
    name: string
    mutex?: boolean
  }>
  blocks: Array<{
    key: string
    title: string
    title_font_size?: string
    markdown_template: string
    stage: string
    start_at?: string
    end_at?: string
    condition: {
      groups?: string[]
      users?: string[]
    }
    sort_order: number
    block_group_key?: string
  }>
  members: Array<{
    email: string
    group_key: string
  }>
}

export default function AdminTransitionPageEdit() {
  const router = useRouter()
  const params = useParams()
  const { toast } = useToast()
  const pageId = params.id as string

  const [page, setPage] = useState<TransitionPageDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  // Form states
  const [title, setTitle] = useState('')
  const [slug, setSlug] = useState('')
  const [status, setStatus] = useState('draft')
  const [titleFontSize, setTitleFontSize] = useState('large')

  // Add group dialog
  const [addingGroup, setAddingGroup] = useState(false)
  const [newGroupKey, setNewGroupKey] = useState('')
  const [newGroupName, setNewGroupName] = useState('')

  // Add block group dialog
  const [addingBlockGroup, setAddingBlockGroup] = useState(false)
  const [newBlockGroupKey, setNewBlockGroupKey] = useState('')
  const [newBlockGroupName, setNewBlockGroupName] = useState('')
  const [newBlockGroupMutex, setNewBlockGroupMutex] = useState(false)

  // Add block dialog
  const [addingBlock, setAddingBlock] = useState(false)
  const [newBlockKey, setNewBlockKey] = useState('')
  const [newBlockTitle, setNewBlockTitle] = useState('')
  const [newBlockTemplate, setNewBlockTemplate] = useState('')
  const [newBlockFontSize, setNewBlockFontSize] = useState('large')
  const [newBlockFreezeEnabled, setNewBlockFreezeEnabled] = useState(false)
  const [newBlockBlockGroupKey, setNewBlockBlockGroupKey] = useState<string>('')
  const [newBlockButtons, setNewBlockButtons] = useState<Array<{ label: string; url_template: string; variant: string; target: string; freeze_on_click?: boolean }>>([])

  // Manual user add form
  const [newUserEmail, setNewUserEmail] = useState('')
  const [newUserGroup, setNewUserGroup] = useState('')
  const [newUserContent, setNewUserContent] = useState('{"name":"","company":""}')

  // Edit dialog states
  const [editingBlock, setEditingBlock] = useState<TransitionPageDetail['blocks'][0] | null>(null)
  const [editBlockKey, setEditBlockKey] = useState('')
  const [editBlockTitle, setEditBlockTitle] = useState('')
  const [editBlockTemplate, setEditBlockTemplate] = useState('')
  const [editBlockStartAt, setEditBlockStartAt] = useState('')
  const [editBlockEndAt, setEditBlockEndAt] = useState('')
  const [editBlockGroups, setEditBlockGroups] = useState<string[]>([])
  const [editBlockButtons, setEditBlockButtons] = useState<Array<{ label: string; url_template: string; variant: string; target: string; freeze_on_click?: boolean }>>([])
  const [editBlockFontSize, setEditBlockFontSize] = useState('large')
  const [editBlockStage, setEditBlockStage] = useState('always')
  const [editBlockFreezeEnabled, setEditBlockFreezeEnabled] = useState(false)
  const [editBlockBlockGroupKey, setEditBlockBlockGroupKey] = useState<string>('')

  const [editingGroup, setEditingGroup] = useState<TransitionPageDetail['groups'][0] | null>(null)
  const [editGroupName, setEditGroupName] = useState('')
  const [editGroupStartAt, setEditGroupStartAt] = useState('')
  const [editGroupEndAt, setEditGroupEndAt] = useState('')
  const [editGroupContent, setEditGroupContent] = useState('{}')

  // Edit block group dialog
  const [editingBlockGroup, setEditingBlockGroup] = useState<TransitionPageDetail['block_groups'][0] | null>(null)
  const [editBlockGroupName, setEditBlockGroupName] = useState('')
  const [editBlockGroupMutex, setEditBlockGroupMutex] = useState(false)

  // Edit member content dialog
  const [editingMember, setEditingMember] = useState<TransitionPageDetail['members'][0] | null>(null)

  // Excel import states
  const [excelData, setExcelData] = useState<any[]>([])
  const [excelHeaders, setExcelHeaders] = useState<string[]>([])
  const [emailColumn, setEmailColumn] = useState('')
  const [importGroupKey, setImportGroupKey] = useState('')
  const [contentMapping, setContentMapping] = useState('{"name": "", "url": ""}')
  const [showImportPreview, setShowImportPreview] = useState(false)
  const [previewData, setPreviewData] = useState<any[]>([])
  const [importing, setImporting] = useState(false)

  // User views states
  const [userViews, setUserViews] = useState<Array<{email: string; viewed_blocks: Record<string, {frozen_at: string; source: string}>; updated_at: string}>>([])
  const [loadingViews, setLoadingViews] = useState(false)

  // Member management states
  const [selectedMembers, setSelectedMembers] = useState<Set<string>>(new Set())
  const [memberSearchQuery, setMemberSearchQuery] = useState('')
  const [memberPage, setMemberPage] = useState(1)
  const MEMBERS_PER_PAGE = 20
  const [showMemberManager, setShowMemberManager] = useState(false)
  const [managingGroupKey, setManagingGroupKey] = useState<string>('')
  const [newMemberEmail, setNewMemberEmail] = useState('')
  const [newMemberContent, setNewMemberContent] = useState('{}')
  const [editMemberContent, setEditMemberContent] = useState('')

  useEffect(() => {
    loadPage()
  }, [pageId])

  const loadPage = async () => {
    try {
      const token = getToken()
      const response = await fetch(`/api/v1/transition-pages/${pageId}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!response.ok) throw new Error('Failed to load page')
      const data = await response.json()
      setPage(data)
      setTitle(data.title)
      setSlug(data.slug)
      setStatus(data.status)
      setTitleFontSize(data.title_font_size || 'large')
    } catch (error) {
      toast({
        title: '加载失败',
        description: error instanceof Error ? error.message : '未知错误',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const token = getToken()
      const response = await fetch(`/api/v1/transition-pages/${pageId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ title, status, title_font_size: titleFontSize }),
      })
      if (!response.ok) throw new Error('Failed to save')
      toast({ title: '保存成功' })
    } catch (error) {
      toast({
        title: '保存失败',
        description: error instanceof Error ? error.message : '未知错误',
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  const loadUserViews = async () => {
    setLoadingViews(true)
    try {
      const token = getToken()
      const response = await fetch(`/api/v1/transition-pages/${pageId}/user-views`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!response.ok) throw new Error('Failed to load')
      const data = await response.json()
      setUserViews(data)
    } catch (error) {
      toast({
        title: '加载失败',
        description: error instanceof Error ? error.message : '未知错误',
        variant: 'destructive',
      })
    } finally {
      setLoadingViews(false)
    }
  }

  const handleDeleteUserView = async (email: string) => {
    if (!confirm(`确定要删除 ${email} 的访问记录吗？`)) return
    try {
      const token = getToken()
      const response = await fetch(`/api/v1/transition-pages/${pageId}/user-views/${email}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!response.ok) throw new Error('Failed to delete')
      toast({ title: '删除成功' })
      loadUserViews()
    } catch (error) {
      toast({
        title: '删除失败',
        description: error instanceof Error ? error.message : '未知错误',
        variant: 'destructive',
      })
    }
  }

  const openAddGroup = () => {
    setAddingGroup(true)
    setNewGroupKey('')
    setNewGroupName('')
  }

  const saveAddGroup = async () => {
    if (!newGroupKey || !newGroupName) {
      toast({ title: '请填写完整信息', variant: 'destructive' })
      return
    }
    try {
      const token = getToken()
      const response = await fetch(`/api/v1/transition-pages/${pageId}/groups`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          key: newGroupKey,
          data: { name: newGroupName, start_at: null, end_at: null },
        }),
      })
      if (!response.ok) throw new Error('Failed to add group')
      toast({ title: '用户组添加成功' })
      setAddingGroup(false)
      setNewGroupKey('')
      setNewGroupName('')
      loadPage()
    } catch (error) {
      toast({
        title: '添加失败',
        description: error instanceof Error ? error.message : '未知错误',
        variant: 'destructive',
      })
    }
  }

  const saveAddBlockGroup = async () => {
    if (!newBlockGroupKey || !newBlockGroupName) {
      toast({ title: '请填写完整信息', variant: 'destructive' })
      return
    }
    try {
      const token = getToken()
      const response = await fetch(`/api/v1/transition-pages/${pageId}/block-groups`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          key: newBlockGroupKey,
          data: { name: newBlockGroupName, mutex: newBlockGroupMutex },
        }),
      })
      if (!response.ok) throw new Error('Failed to add block group')
      toast({ title: '区块组添加成功' })
      setAddingBlockGroup(false)
      setNewBlockGroupKey('')
      setNewBlockGroupName('')
      setNewBlockGroupMutex(false)
      loadPage()
    } catch (error) {
      toast({
        title: '添加失败',
        description: error instanceof Error ? error.message : '未知错误',
        variant: 'destructive',
      })
    }
  }

  const handleUpdateGroup = async (
    groupKey: string,
    data: { name?: string; start_at?: string; end_at?: string; content?: any }
  ) => {
    try {
      const token = getToken()
      const response = await fetch(
        `/api/v1/transition-pages/${pageId}/groups/${groupKey}`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            data: {
              name: data.name,
              start_at: data.start_at || null,
              end_at: data.end_at || null,
              content: data.content || {},
            }
          }),
        }
      )
      if (!response.ok) throw new Error('Failed to update')
      toast({ title: '更新成功' })
      loadPage()
    } catch (error) {
      toast({
        title: '更新失败',
        description: error instanceof Error ? error.message : '未知错误',
        variant: 'destructive',
      })
    }
  }

  const handleDeleteGroup = async (groupKey: string) => {
    if (!confirm('确定删除此用户组？')) return
    try {
      const token = getToken()
      const response = await fetch(
        `/api/v1/transition-pages/${pageId}/groups/${groupKey}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        }
      )
      if (!response.ok) throw new Error('Failed to delete')
      toast({ title: '删除成功' })
      loadPage()
    } catch (error) {
      toast({
        title: '删除失败',
        description: error instanceof Error ? error.message : '未知错误',
        variant: 'destructive',
      })
    }
  }

  const handleDeleteBlockGroup = async (blockGroupKey: string) => {
    if (!confirm('确定删除此区块组？')) return
    try {
      const token = getToken()
      const response = await fetch(
        `/api/v1/transition-pages/${pageId}/block-groups/${blockGroupKey}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        }
      )
      if (!response.ok) throw new Error('Failed to delete')
      toast({ title: '删除成功' })
      loadPage()
    } catch (error) {
      toast({
        title: '删除失败',
        description: error instanceof Error ? error.message : '未知错误',
        variant: 'destructive',
      })
    }
  }

  const handleDeleteMember = async (email: string) => {
    if (!confirm(`确定删除用户 ${email}？`)) return
    try {
      const token = getToken()
      const response = await fetch(
        `/api/v1/transition-pages/${pageId}/members/${encodeURIComponent(email)}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        }
      )
      if (!response.ok) throw new Error('Failed to delete')
      toast({ title: '删除成功' })
      loadPage()
    } catch (error) {
      toast({
        title: '删除失败',
        description: error instanceof Error ? error.message : '未知错误',
        variant: 'destructive',
      })
    }
  }

  const handleBatchDeleteMembers = async () => {
    if (selectedMembers.size === 0) {
      toast({ title: '请先选择用户', variant: 'destructive' })
      return
    }
    if (!confirm(`确定删除选中的 ${selectedMembers.size} 个用户？`)) return

    let success = 0
    let failed = 0
    for (const email of selectedMembers) {
      try {
        const token = getToken()
        const response = await fetch(
          `/api/v1/transition-pages/${pageId}/members/${encodeURIComponent(email)}`,
          {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` },
          }
        )
        if (response.ok) success++
        else failed++
      } catch {
        failed++
      }
    }

    toast({
      title: '批量删除完成',
      description: `成功: ${success}, 失败: ${failed}`,
    })
    setSelectedMembers(new Set())
    loadPage()
  }

  const openMemberManager = (groupKey: string) => {
    setManagingGroupKey(groupKey)
    setSelectedMembers(new Set())
    setMemberSearchQuery('')
    setMemberPage(1)
    setNewMemberEmail('')
    setNewMemberContent('{}')
    setShowMemberManager(true)
  }

  const handleAddMemberToGroup = async () => {
    if (!newMemberEmail || !managingGroupKey) {
      toast({ title: '请输入邮箱', variant: 'destructive' })
      return
    }

    try {
      const token = getToken()

      // Add member to group
      const response = await fetch(
        `/api/v1/transition-pages/${pageId}/groups/${managingGroupKey}/members`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ email: newMemberEmail }),
        }
      )

      if (!response.ok) {
        const error = await response.text()
        throw new Error(error)
      }

      // Set content if provided
      let content = {}
      try {
        content = JSON.parse(newMemberContent)
      } catch {
        // ignore invalid JSON
      }

      if (Object.keys(content).length > 0) {
        await fetch(
          `/api/v1/transition-pages/${pageId}/members/${encodeURIComponent(newMemberEmail)}/content`,
          {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ content }),
          }
        )
      }

      toast({ title: '添加成功' })
      setNewMemberEmail('')
      setNewMemberContent('{}')
      loadPage()
    } catch (error) {
      toast({
        title: '添加失败',
        description: error instanceof Error ? error.message : '未知错误',
        variant: 'destructive',
      })
    }
  }

  const openAddBlock = () => {
    setAddingBlock(true)
    setNewBlockKey('')
    setNewBlockTitle('')
    setNewBlockTemplate('')
    setNewBlockFontSize('large')
    setNewBlockButtons([])
  }

  const saveAddBlock = async () => {
    if (!newBlockKey || !newBlockTitle || !newBlockTemplate) {
      toast({ title: '请填写完整信息', variant: 'destructive' })
      return
    }
    try {
      const token = getToken()
      const response = await fetch(`/api/v1/transition-pages/${pageId}/blocks`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          key: newBlockKey,
          data: {
            title: newBlockTitle,
            title_font_size: newBlockFontSize,
            markdown_template: newBlockTemplate,
            stage: 'always',
            condition: { groups: [], users: [] },
            buttons: newBlockButtons,
            freeze_enabled: newBlockFreezeEnabled,
            block_group_key: newBlockBlockGroupKey || null,
          },
          sort_order: page?.blocks.length || 0,
        }),
      })
      if (!response.ok) throw new Error('Failed to add block')
      toast({ title: '区块添加成功' })
      setAddingBlock(false)
      setNewBlockButtons([])
      loadPage()
    } catch (error) {
      toast({
        title: '添加失败',
        description: error instanceof Error ? error.message : '未知错误',
        variant: 'destructive',
      })
    }
  }

  const handleUpdateBlock = async (
    blockKey: string,
    data: {
      title?: string
      title_font_size?: string
      markdown_template?: string
      stage?: string
      start_at?: string
      end_at?: string
      groups?: string[]
      buttons?: Array<{ label: string; url_template: string; variant: string; target: string }>
      freeze_enabled?: boolean
      block_group_key?: string | null
    }
  ) => {
    try {
      const token = getToken()
      const response = await fetch(
        `/api/v1/transition-pages/${pageId}/blocks/${blockKey}`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            data: {
              title: data.title,
              title_font_size: data.title_font_size,
              markdown_template: data.markdown_template,
              stage: data.stage || 'always',
              start_at: data.start_at || null,
              end_at: data.end_at || null,
              condition: {
                groups: data.groups || [],
                users: [],
              },
              buttons: data.buttons || [],
              freeze_enabled: data.freeze_enabled ?? false,
              block_group_key: data.block_group_key ?? null,
            },
          }),
        }
      )
      if (!response.ok) throw new Error('Failed to update')
      toast({ title: '更新成功' })
      loadPage()
    } catch (error) {
      toast({
        title: '更新失败',
        description: error instanceof Error ? error.message : '未知错误',
        variant: 'destructive',
      })
    }
  }

  const handleDeleteBlock = async (blockKey: string) => {
    if (!confirm('确定删除此区块？')) return
    try {
      const token = getToken()
      const response = await fetch(
        `/api/v1/transition-pages/${pageId}/blocks/${blockKey}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        }
      )
      if (!response.ok) throw new Error('Failed to delete')
      toast({ title: '删除成功' })
      loadPage()
    } catch (error) {
      toast({
        title: '删除失败',
        description: error instanceof Error ? error.message : '未知错误',
        variant: 'destructive',
      })
    }
  }

  const handleMoveBlock = async (blockKey: string, direction: 'up' | 'down') => {
    if (!page) return
    const blocks = [...page.blocks]
    const index = blocks.findIndex(b => b.key === blockKey)
    if (index === -1) return

    const newIndex = direction === 'up' ? index - 1 : index + 1
    if (newIndex < 0 || newIndex >= blocks.length) return

    // Swap positions in array
    const temp = blocks[index]
    blocks[index] = blocks[newIndex]
    blocks[newIndex] = temp

    // Update sort_order to match new positions
    const updatedBlocks = blocks.map((b, i) => ({ ...b, sort_order: i }))

    try {
      const token = getToken()
      // Update all blocks with new sort_order
      await Promise.all(
        updatedBlocks.map(b =>
          fetch(`/api/v1/transition-pages/${pageId}/blocks/${b.key}`, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ sort_order: b.sort_order }),
          })
        )
      )
      toast({ title: '排序已更新' })
      loadPage()
    } catch (error) {
      toast({
        title: '排序更新失败',
        description: error instanceof Error ? error.message : '未知错误',
        variant: 'destructive',
      })
    }
  }

  const handleExcelUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    try {
      const data = await file.arrayBuffer()
      const workbook = XLSX.read(data, { type: 'array' })
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]]
      const jsonData = XLSX.utils.sheet_to_json(firstSheet, { header: 1 })

      if (jsonData.length < 2) {
        toast({ title: 'Excel文件为空或格式错误', variant: 'destructive' })
        return
      }

      const headers = (jsonData[0] as string[]).map(h => String(h).trim())
      const rows = jsonData.slice(1).filter(row => (row as any[]).some(cell => cell !== undefined && cell !== ''))

      setExcelHeaders(headers)
      setExcelData(rows)
      setEmailColumn('')
      setImportGroupKey('')
      setContentMapping('{"name": "", "url": ""}')
      setShowImportPreview(true)
      toast({ title: `读取成功，共 ${rows.length} 行数据` })
    } catch (error) {
      toast({
        title: '读取Excel失败',
        description: error instanceof Error ? error.message : '未知错误',
        variant: 'destructive',
      })
    }
  }

  const generatePreview = () => {
    if (!emailColumn || !importGroupKey) {
      toast({ title: '请选择email列和输入group_key', variant: 'destructive' })
      return
    }

    let mapping: Record<string, string>
    try {
      mapping = JSON.parse(contentMapping)
    } catch {
      toast({ title: 'Content映射JSON格式错误', variant: 'destructive' })
      return
    }

    const emailIdx = excelHeaders.indexOf(emailColumn)
    if (emailIdx === -1) {
      toast({ title: '未找到email列', variant: 'destructive' })
      return
    }

    const preview = excelData.map((row: any, idx: number) => {
      const email = row[emailIdx]?.toString().trim()
      const content: Record<string, any> = {}
      for (const [key, header] of Object.entries(mapping)) {
        if (header) {
          const colIdx = excelHeaders.indexOf(header as string)
          content[key] = colIdx !== -1 ? row[colIdx] : ''
        }
      }
      return { email, group_key: importGroupKey, content, rowIdx: idx }
    }).filter(item => item.email)

    setPreviewData(preview)
  }

  const exportPreviewToCSV = () => {
    if (previewData.length === 0) {
      toast({ title: '没有数据可导出', variant: 'destructive' })
      return
    }

    const headers = ['email', 'group_key', 'content']
    const rows = previewData.map(item => [
      item.email,
      item.group_key,
      JSON.stringify(item.content)
    ])

    // Properly escape CSV values: wrap in quotes and escape inner quotes
    const escapeCSV = (v: string) => {
      const escaped = v.replace(/"/g, '""')
      return `"${escaped}"`
    }

    const csv = [headers.join(','), ...rows.map(r => r.map(escapeCSV).join(','))].join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = `import_preview_${pageId}.csv`
    link.click()
    toast({ title: 'CSV导出成功' })
  }

  const batchImportUsers = async () => {
    if (previewData.length === 0) {
      toast({ title: '没有数据可导入', variant: 'destructive' })
      return
    }

    setImporting(true)
    try {
      const token = getToken()

      // Convert preview data to CSV with proper escaping
      const headers = ['email', 'group_key', 'content']
      const rows = previewData.map(item => [
        item.email,
        item.group_key,
        JSON.stringify(item.content)
      ])
      const escapeCSV = (v: string) => {
        const escaped = v.replace(/"/g, '""')
        return `"${escaped}"`
      }
      const csvContent = [headers.join(','), ...rows.map(r => r.map(escapeCSV).join(','))].join('\n')

      const blob = new Blob([csvContent], { type: 'text/csv' })
      const formData = new FormData()
      formData.append('file', blob, 'import.csv')

      const response = await fetch(
        `/api/v1/transition-pages/${pageId}/import`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: formData,
        }
      )

      if (!response.ok) throw new Error('Import failed')
      const result = await response.json()

      toast({
        title: '导入完成',
        description: `成功: ${result.success}, 失败: ${result.failed}`,
      })
      setShowImportPreview(false)
      loadPage()
    } catch (error) {
      toast({
        title: '导入失败',
        description: error instanceof Error ? error.message : '未知错误',
        variant: 'destructive',
      })
    } finally {
      setImporting(false)
    }
  }

  // Open edit dialogs
  const openEditBlock = (block: TransitionPageDetail['blocks'][0]) => {
    setEditingBlock(block)
    setEditBlockKey(block.key)
    setEditBlockTitle(block.title)
    setEditBlockTemplate(block.markdown_template)
    setEditBlockStartAt(block.start_at || '')
    setEditBlockEndAt(block.end_at || '')
    setEditBlockGroups(block.condition?.groups || [])
    setEditBlockButtons((block as any).buttons || [])
    setEditBlockFontSize(block.title_font_size || 'large')
    setEditBlockStage(block.stage || 'always')
    setEditBlockFreezeEnabled((block as any).freeze_enabled || false)
    setEditBlockBlockGroupKey(block.block_group_key || '')
  }

  const openEditGroup = (group: TransitionPageDetail['groups'][0]) => {
    setEditingGroup(group)
    setEditGroupName(group.name)
    setEditGroupStartAt(group.start_at || '')
    setEditGroupEndAt(group.end_at || '')
    setEditGroupContent(JSON.stringify((group as any).content || {}, null, 2))
  }

  const openEditBlockGroup = (blockGroup: TransitionPageDetail['block_groups'][0]) => {
    setEditingBlockGroup(blockGroup)
    setEditBlockGroupName(blockGroup.name)
    setEditBlockGroupMutex(blockGroup.mutex || false)
  }

  const saveBlockGroupEdit = async () => {
    if (!editingBlockGroup) return
    try {
      const token = getToken()
      const response = await fetch(
        `/api/v1/transition-pages/${pageId}/block-groups/${editingBlockGroup.key}`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            data: {
              name: editBlockGroupName,
              mutex: editBlockGroupMutex,
            },
          }),
        }
      )
      if (!response.ok) throw new Error('Failed to update block group')
      toast({ title: '区块组更新成功' })
      setEditingBlockGroup(null)
      loadPage()
    } catch (error) {
      toast({
        title: '更新失败',
        description: error instanceof Error ? error.message : '未知错误',
        variant: 'destructive',
      })
    }
  }

  const saveBlockEdit = async () => {
    if (!editingBlock) return
    await handleUpdateBlock(editingBlock.key, {
      title: editBlockTitle,
      title_font_size: editBlockFontSize,
      markdown_template: editBlockTemplate,
      stage: editBlockStage,
      start_at: editBlockStartAt,
      end_at: editBlockEndAt,
      groups: editBlockGroups,
      buttons: editBlockButtons,
      freeze_enabled: editBlockFreezeEnabled,
      block_group_key: editBlockBlockGroupKey || null,
    })
    setEditingBlock(null)
  }

  const saveGroupEdit = async () => {
    if (!editingGroup) return
    let content = {}
    try {
      content = JSON.parse(editGroupContent)
    } catch {
      toast({ title: 'JSON格式错误', variant: 'destructive' })
      return
    }
    await handleUpdateGroup(editingGroup.key, {
      name: editGroupName,
      start_at: editGroupStartAt,
      end_at: editGroupEndAt,
      content,
    })
    setEditingGroup(null)
  }

  const openEditMember = async (member: TransitionPageDetail['members'][0]) => {
    setEditingMember(member)
    try {
      const token = getToken()
      const response = await fetch(
        `/api/v1/transition-pages/${pageId}/members/${encodeURIComponent(member.email)}/content`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      if (response.ok) {
        const data = await response.json()
        setEditMemberContent(JSON.stringify(data.content || {}, null, 2))
      } else {
        setEditMemberContent('{}')
      }
    } catch {
      setEditMemberContent('{}')
    }
  }

  const saveMemberContent = async () => {
    if (!editingMember) return
    try {
      const token = getToken()
      const content = JSON.parse(editMemberContent)
      const response = await fetch(
        `/api/v1/transition-pages/${pageId}/members/${encodeURIComponent(editingMember.email)}/content`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ content }),
        }
      )
      if (!response.ok) throw new Error('Failed to update')
      toast({ title: '保存成功' })
      setEditingMember(null)
      loadPage()
    } catch (error) {
      toast({
        title: '保存失败',
        description: error instanceof Error ? error.message : '未知错误',
        variant: 'destructive',
      })
    }
  }

  const handleAddUser = async () => {
    if (!newUserEmail || !newUserGroup) {
      toast({
        title: '请填写完整信息',
        description: '邮箱和用户组不能为空',
        variant: 'destructive',
      })
      return
    }

    try {
      const token = getToken()

      // Add group member
      const memberResponse = await fetch(
        `/api/v1/transition-pages/${pageId}/groups/${newUserGroup}/members`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ email: newUserEmail }),
        }
      )

      if (!memberResponse.ok) {
        // Try alternative endpoint
        const altResponse = await fetch(
          `/api/v1/transition-pages/${pageId}/import`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            body: (() => {
              const formData = new FormData()
              const csvContent = `email,group_key,content\n${newUserEmail},${newUserGroup},${newUserContent}`
              const blob = new Blob([csvContent], { type: 'text/csv' })
              formData.append('file', blob, 'user.csv')
              return formData
            })(),
          }
        )
        if (!altResponse.ok) throw new Error('Failed to add user')
      }

      toast({ title: '用户添加成功' })
      setNewUserEmail('')
      setNewUserContent('{"name":"","company":""}')
    } catch (error) {
      toast({
        title: '添加失败',
        description: error instanceof Error ? error.message : '未知错误',
        variant: 'destructive',
      })
    }
  }

  const handleExportUsers = async () => {
    try {
      const token = getToken()
      const response = await fetch(
        `/api/v1/transition-pages/${pageId}/export`,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      )
      if (!response.ok) throw new Error('Export failed')
      const result = await response.json()

      // Download CSV
      const blob = new Blob([result.content], { type: 'text/csv' })
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = result.filename
      a.click()
    } catch (error) {
      toast({
        title: '导出失败',
        description: error instanceof Error ? error.message : '未知错误',
        variant: 'destructive',
      })
    }
  }

  if (loading) {
    return (
      <div className="container mx-auto py-8 px-4">
        <div className="text-center py-12">加载中...</div>
      </div>
    )
  }

  if (!page) {
    return (
      <div className="container mx-auto py-8 px-4">
        <div className="text-center py-12 text-gray-500">页面不存在</div>
      </div>
    )
  }

  return (
    <div className="container mx-auto py-8 px-4 max-w-5xl">
      <div className="flex items-center gap-4 mb-8">
        <Button variant="ghost" onClick={() => router.push('/admin/transition-pages')}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div className="flex-1">
          <h1 className="text-2xl font-semibold">{page.title}</h1>
          <p className="text-sm text-gray-500">
            /t/{page.slug} · {page.status === 'draft' ? '草稿' : '已发布'}
          </p>
        </div>
        <Button onClick={handleSave} disabled={saving} className="bg-teal-600">
          {saving ? '保存中...' : '保存'}
        </Button>
      </div>

      <Tabs defaultValue="basic">
        <TabsList className="mb-6">
          <TabsTrigger value="basic">
            <Settings className="w-4 h-4 mr-2" />基本信息
          </TabsTrigger>
          <TabsTrigger value="groups">
            <Users className="w-4 h-4 mr-2" />用户组
          </TabsTrigger>
          <TabsTrigger value="blocks">
            <Layout className="w-4 h-4 mr-2" />内容区块
          </TabsTrigger>
          <TabsTrigger value="users">
            <Upload className="w-4 h-4 mr-2" />用户导入
          </TabsTrigger>
          <TabsTrigger value="views">
            <Eye className="w-4 h-4 mr-2" />访问记录
          </TabsTrigger>
        </TabsList>

        <TabsContent value="basic">
          <Card>
            <CardHeader>
              <CardTitle>基本信息</CardTitle>
              <CardDescription>配置页面标题和状态</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label>页面标题</Label>
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="输入页面标题"
                />
              </div>
              <div>
                <Label>URL Slug</Label>
                <Input value={slug} disabled className="bg-gray-50" />
                <p className="text-sm text-gray-500 mt-1">访问路径: /t/{slug}</p>
              </div>
              <div>
                <Label>状态</Label>
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                  className="w-full border rounded-md px-3 py-2"
                >
                  <option value="draft">草稿</option>
                  <option value="published">已发布</option>
                </select>
              </div>
              <div>
                <Label>标题字号</Label>
                <select
                  value={titleFontSize}
                  onChange={(e) => setTitleFontSize(e.target.value)}
                  className="w-full border rounded-md px-3 py-2"
                >
                  <option value="small">小 (text-lg)</option>
                  <option value="medium">中 (text-xl)</option>
                  <option value="large">大 (text-2xl)</option>
                  <option value="xlarge">特大 (text-3xl)</option>
                </select>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="groups">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>用户组</CardTitle>
                  <CardDescription>定义不同的用户群体</CardDescription>
                </div>
                <Button onClick={openAddGroup} size="sm">
                  <Plus className="w-4 h-4 mr-1" />添加
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {page.groups.length === 0 ? (
                <p className="text-gray-500 text-center py-8">暂无用户组</p>
              ) : (
                <div className="space-y-2">
                  {page.groups.map((group) => {
                    const groupMembers = page.members.filter(m => m.group_key === group.key)
                    return (
                      <div
                        key={group.key}
                        className="p-3 border rounded-lg"
                      >
                        <div className="flex items-center justify-between">
                          <div>
                            <div className="font-medium">{group.name}</div>
                            <div className="text-sm text-gray-500">标识: {group.key}</div>
                            {(group.start_at || group.end_at) && (
                              <div className="text-xs text-gray-400 mt-1">
                                {group.start_at && `开始: ${new Date(group.start_at).toLocaleDateString()}`}
                                {group.start_at && group.end_at && ' · '}
                                {group.end_at && `结束: ${new Date(group.end_at).toLocaleDateString()}`}
                              </div>
                            )}
                          </div>
                          <div className="flex gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => openEditGroup(group)}
                            >
                              <Settings className="w-4 h-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleDeleteGroup(group.key)}
                            >
                              <Trash2 className="w-4 h-4 text-red-500" />
                            </Button>
                          </div>
                        </div>
                        <div className="mt-3 pt-3 border-t flex items-center justify-between">
                          <div className="text-sm text-gray-500">
                            成员: <span className="font-medium">{groupMembers.length}</span> 人
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => openMemberManager(group.key)}
                          >
                            <Users className="w-4 h-4 mr-1" />
                            管理成员
                          </Button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </CardContent>
          </Card>

        </TabsContent>

        <TabsContent value="blocks">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>内容区块</CardTitle>
                  <CardDescription>配置页面展示的内容</CardDescription>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => setAddingBlockGroup(true)} size="sm">
                    <Plus className="w-4 h-4 mr-1" />新建区块组
                  </Button>
                  <Button onClick={openAddBlock} size="sm">
                    <Plus className="w-4 h-4 mr-1" />添加区块
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {/* Block Groups Summary */}
              {page.block_groups && page.block_groups.length > 0 && (
                <div className="mb-4 p-3 bg-slate-50 rounded-lg">
                  <div className="text-sm font-medium mb-2">区块组</div>
                  <div className="flex flex-wrap gap-2">
                    {page.block_groups.map((bg) => (
                      <div key={bg.key} className="flex items-center gap-1 px-2 py-1 bg-white border rounded text-sm">
                        <span>{bg.name}</span>
                        {bg.mutex && <span className="text-amber-600 text-xs">(互斥)</span>}
                        <button onClick={() => openEditBlockGroup(bg)} className="ml-1 text-gray-400 hover:text-gray-600">
                          <Settings className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {page.blocks.length === 0 ? (
                <p className="text-gray-500 text-center py-8">暂无内容区块</p>
              ) : (
                <div className="space-y-4">
                  {page.blocks.map((block, index) => {
                    const linkedGroups = block.condition?.groups?.map(gk => page?.groups.find(g => g.key === gk)).filter(Boolean) || []
                    return (
                    <div key={block.key} className="border rounded-lg p-4">
                      {/* 头部：标题 + 操作 */}
                      <div className="flex items-start justify-between mb-3">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-lg">{block.title}</span>
                            <Badge variant="secondary">排序 {block.sort_order}</Badge>
                            {block.stage === 'always' ? (
                              <Badge className="bg-green-100 text-green-700 hover:bg-green-100">始终展示</Badge>
                            ) : (
                              <Badge className="bg-blue-100 text-blue-700 hover:bg-blue-100">限时展示</Badge>
                            )}
                            {(block as any).freeze_enabled && (
                              <Badge className="bg-amber-100 text-amber-700 hover:bg-amber-100">已冻结</Badge>
                            )}
                          </div>
                          <div className="text-sm text-gray-500 mt-1">
                            标识: {block.key}
                            {block.block_group_key && (
                              <span className="ml-2 text-blue-600">
                                区块组: {page?.block_groups?.find(bg => bg.key === block.block_group_key)?.name || block.block_group_key}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleMoveBlock(block.key, 'up')}
                            disabled={index === 0}
                          >
                            <ArrowUp className="w-4 h-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleMoveBlock(block.key, 'down')}
                            disabled={index === page.blocks.length - 1}
                          >
                            <ArrowDown className="w-4 h-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => openEditBlock(block)}
                          >
                            <Settings className="w-4 h-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDeleteBlock(block.key)}
                          >
                            <Trash2 className="w-4 h-4 text-red-500" />
                          </Button>
                        </div>
                      </div>

                      {/* 按钮数量 */}
                      {(block as any).buttons?.length > 0 && (
                        <div className="flex items-center gap-2 mb-2 text-sm">
                          <span className="text-gray-500">按钮:</span>
                          <Badge variant="info">{(block as any).buttons.length} 个</Badge>
                        </div>
                      )}

                      {/* 用户组信息 */}
                      {linkedGroups.length > 0 && (
                        <div className="mb-3">
                          <div className="text-sm text-gray-500 mb-2">绑定用户组:</div>
                          <div className="space-y-2">
                            {linkedGroups.map(g => (
                              <div
                                key={g!.key}
                                className="bg-gray-50 rounded px-3 py-2 text-sm cursor-pointer hover:bg-gray-100"
                                onClick={() => openEditGroup(g!)}
                              >
                                <div className="flex items-center justify-between">
                                  <span className="font-medium">{g!.name}</span>
                                  <span className="text-xs text-gray-400">点击编辑</span>
                                </div>
                                {(g!.start_at || g!.end_at) && (
                                  <div className="text-xs text-gray-500 mt-1">
                                    组时间: {g!.start_at ? new Date(g!.start_at).toLocaleString() : '无'} ~ {g!.end_at ? new Date(g!.end_at).toLocaleString() : '无'}
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Block 自身时间 */}
                      {(block.start_at || block.end_at) && (
                        <div className="flex items-center gap-2 text-sm">
                          <span className="text-gray-500">Block时间:</span>
                          <span className="text-gray-700">
                            {block.start_at ? new Date(block.start_at).toLocaleString() : '无'} ~ {block.end_at ? new Date(block.end_at).toLocaleString() : '无'}
                          </span>
                        </div>
                      )}
                    </div>
                    )
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="users">
          <div className="space-y-6">
            {/* Manual Add User */}
            <Card>
              <CardHeader>
                <CardTitle>手动添加用户</CardTitle>
                <CardDescription>逐个添加用户到指定分组</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label>用户邮箱</Label>
                    <Input
                      placeholder="user@example.com"
                      value={newUserEmail}
                      onChange={(e) => setNewUserEmail(e.target.value)}
                    />
                  </div>
                  <div>
                    <Label>用户组</Label>
                    <select
                      value={newUserGroup}
                      onChange={(e) => setNewUserGroup(e.target.value)}
                      className="w-full border rounded-md px-3 py-2"
                    >
                      <option value="">选择用户组</option>
                      {page?.groups.map((g) => (
                        <option key={g.key} value={g.key}>
                          {g.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div>
                  <Label>用户数据 (JSON)</Label>
                  <Textarea
                    value={newUserContent}
                    onChange={(e) => setNewUserContent(e.target.value)}
                    placeholder='{"name":"张三","company":"阿里"}'
                    rows={3}
                  />
                  <p className="text-sm text-gray-500 mt-1">
                    支持模板变量如 {"{content.name}"}、{"{content.company}"}
                  </p>
                </div>
                <Button onClick={handleAddUser} className="bg-teal-600">
                  <UserPlus className="w-4 h-4 mr-2" />
                  添加用户
                </Button>
              </CardContent>
            </Card>

            {/* Excel Import */}
            <Card>
              <CardHeader>
                <CardTitle>Excel 批量导入</CardTitle>
                <CardDescription>上传 Excel 文件，配置列映射后导入</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="flex gap-4">
                  <Button variant="outline" onClick={handleExportUsers}>
                    <Download className="w-4 h-4 mr-2" />
                    导出用户数据
                  </Button>
                  <div className="relative">
                    <input
                      type="file"
                      accept=".xlsx,.xls"
                      onChange={handleExcelUpload}
                      className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                    />
                    <Button variant="outline">
                      <FileSpreadsheet className="w-4 h-4 mr-2" />
                      上传 Excel
                    </Button>
                  </div>
                </div>

                <div className="bg-gray-50 p-4 rounded-lg">
                  <h4 className="font-medium mb-2">使用说明</h4>
                  <p className="text-sm text-gray-600">1. 上传 Excel 文件（.xlsx 或 .xls）</p>
                  <p className="text-sm text-gray-600">2. 选择 Email 所在列和用户组</p>
                  <p className="text-sm text-gray-600">3. 配置 Content 字段映射</p>
                  <p className="text-sm text-gray-600">4. 预览后批量导入或导出 CSV</p>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="views">
          <Card>
            <CardHeader>
              <CardTitle>用户访问记录</CardTitle>
              <CardDescription>查看和管理用户的区块访问记录</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="mb-4">
                <Button onClick={loadUserViews} variant="outline" disabled={loadingViews}>
                  {loadingViews ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Eye className="w-4 h-4 mr-2" />}
                  刷新记录
                </Button>
              </div>

              {userViews.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  暂无访问记录
                </div>
              ) : (
                <div className="space-y-4">
                  {userViews.map((view) => (
                    <div key={view.email} className="border rounded-lg p-4">
                      <div className="flex items-start justify-between">
                        <div>
                          <div className="font-medium">{view.email}</div>
                          <div className="text-sm text-gray-500 mt-1">
                            最后更新: {new Date(view.updated_at).toLocaleString('zh-CN')}
                          </div>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDeleteUserView(view.email)}
                          className="text-red-500"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {Object.entries(view.viewed_blocks).map(([blockKey, blockData]) => {
                          const frozenAt = typeof blockData === 'object' ? blockData.frozen_at : blockData
                          const source = typeof blockData === 'object' ? blockData.source : 'view'
                          const sourceLabel = source === 'click' ? '点击' : '浏览'
                          return (
                            <Badge key={blockKey} variant="secondary" className="text-xs">
                              {blockKey}: {new Date(frozenAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })} ({sourceLabel})
                            </Badge>
                          )
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Excel Import Preview Dialog */}
      <Dialog open={showImportPreview} onOpenChange={setShowImportPreview}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Excel 导入配置</DialogTitle>
            <DialogDescription>配置列映射并预览数据</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {excelHeaders.length > 0 && (
              <>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label>Email 列 *</Label>
                    <select
                      value={emailColumn}
                      onChange={(e) => setEmailColumn(e.target.value)}
                      className="w-full border rounded-md px-3 py-2"
                    >
                      <option value="">选择列</option>
                      {excelHeaders.map((h) => (
                        <option key={h} value={h}>{h}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <Label>用户组 *</Label>
                    <select
                      value={importGroupKey}
                      onChange={(e) => setImportGroupKey(e.target.value)}
                      className="w-full border rounded-md px-3 py-2"
                    >
                      <option value="">选择用户组</option>
                      {page?.groups.map((g) => (
                        <option key={g.key} value={g.key}>{g.name}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <Label>Content 字段映射</Label>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        try {
                          const mapping = JSON.parse(contentMapping)
                          const newKey = prompt('输入字段名 (如: name, url)')
                          if (newKey) {
                            setContentMapping(JSON.stringify({ ...mapping, [newKey]: '' }))
                          }
                        } catch {
                          toast({ title: 'JSON格式错误', variant: 'destructive' })
                        }
                      }}
                    >
                      <Plus className="w-4 h-4 mr-1" />添加字段
                    </Button>
                  </div>
                  <div className="space-y-2 border rounded-lg p-3">
                    {(() => {
                      try {
                        const mapping = JSON.parse(contentMapping)
                        return Object.entries(mapping).map(([key, header]) => (
                          <div key={key} className="flex items-center gap-2">
                            <span className="text-sm font-medium w-24 truncate">{key}</span>
                            <span className="text-gray-400">→</span>
                            <select
                              value={header as string}
                              onChange={(e) => {
                                const updated = { ...mapping, [key]: e.target.value }
                                setContentMapping(JSON.stringify(updated))
                              }}
                              className="flex-1 border rounded px-2 py-1 text-sm"
                            >
                              <option value="">不映射</option>
                              {excelHeaders.map((h) => (
                                <option key={h} value={h}>{h}</option>
                              ))}
                            </select>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                const { [key]: _, ...rest } = mapping
                                setContentMapping(JSON.stringify(rest))
                              }}
                            >
                              <Trash2 className="w-4 h-4 text-red-500" />
                            </Button>
                          </div>
                        ))
                      } catch {
                        return <p className="text-sm text-red-500">JSON格式错误</p>
                      }
                    })()}
                  </div>
                  {(() => {
                    try {
                      const mapping = JSON.parse(contentMapping)
                      return Object.keys(mapping).length === 0 && (
                        <p className="text-xs text-gray-500 mt-2">点击"添加字段"创建映射</p>
                      )
                    } catch { return null }
                  })()}
                </div>
                <Button onClick={generatePreview} className="w-full">
                  <Eye className="w-4 h-4 mr-2" />
                  生成预览
                </Button>
              </>
            )}

            {previewData.length > 0 && (
              <div className="border rounded-lg overflow-hidden">
                <div className="bg-gray-50 px-4 py-2 border-b flex items-center justify-between">
                  <span className="font-medium">预览 ({previewData.length} 条)</span>
                </div>
                <div className="max-h-64 overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 sticky top-0">
                      <tr>
                        <th className="px-4 py-2 text-left">Email</th>
                        <th className="px-4 py-2 text-left">Group</th>
                        <th className="px-4 py-2 text-left">Content</th>
                      </tr>
                    </thead>
                    <tbody>
                      {previewData.slice(0, 10).map((item, idx) => (
                        <tr key={idx} className="border-t">
                          <td className="px-4 py-2">{item.email}</td>
                          <td className="px-4 py-2">{item.group_key}</td>
                          <td className="px-4 py-2 text-xs font-mono truncate max-w-xs">
                            {JSON.stringify(item.content)}
                          </td>
                        </tr>
                      ))}
                      {previewData.length > 10 && (
                        <tr>
                          <td colSpan={3} className="px-4 py-2 text-center text-gray-500">
                            还有 {previewData.length - 10} 条...
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setShowImportPreview(false)}>
              取消
            </Button>
            <Button variant="outline" onClick={exportPreviewToCSV} disabled={previewData.length === 0}>
              <Download className="w-4 h-4 mr-2" />
              导出 CSV
            </Button>
            <Button variant="primary" onClick={batchImportUsers} disabled={previewData.length === 0 || importing}>
              {importing ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  导入中...
                </>
              ) : (
                <>
                  <Upload className="w-4 h-4 mr-2" />
                  批量导入
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Block Dialog */}
      <Dialog open={!!editingBlock} onOpenChange={() => setEditingBlock(null)}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>编辑内容区块</DialogTitle>
            <DialogDescription>修改区块的标题、模板和展示条件</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div>
              <Label>区块标识</Label>
              <Input value={editBlockKey} disabled className="bg-gray-100" />
              <p className="text-xs text-gray-500 mt-1">标识不可修改</p>
            </div>
            <div>
              <Label>标题</Label>
              <Input
                value={editBlockTitle}
                onChange={(e) => setEditBlockTitle(e.target.value)}
                placeholder="区块标题"
              />
            </div>
            <div>
              <Label>Markdown 模板</Label>
              <Textarea
                value={editBlockTemplate}
                onChange={(e) => setEditBlockTemplate(e.target.value)}
                placeholder="支持 {{content.xxx}} 用户变量, {{group.name}} {{group.key}} 组变量"
                rows={4}
              />
              <p className="text-xs text-gray-500 mt-1">
                {'用户变量: {{content.name}}, {{content.company}} 等 | 组变量: {{group.name}}, {{group.key}}, {{group.note}}'}
              </p>
            </div>
            <div>
              <Label>标题字号</Label>
              <select
                value={editBlockFontSize}
                onChange={(e) => setEditBlockFontSize(e.target.value)}
                className="w-full border rounded-md px-3 py-2"
              >
                <option value="small">小 (text-lg)</option>
                <option value="medium">中 (text-xl)</option>
                <option value="large">大 (text-2xl)</option>
                <option value="xlarge">特大 (text-3xl)</option>
              </select>
            </div>
            <div>
              <Label>展示阶段</Label>
              <select
                value={editBlockStage}
                onChange={(e) => setEditBlockStage(e.target.value)}
                className="w-full border rounded-md px-3 py-2"
              >
                <option value="always">始终展示（不受组时间限制）</option>
                <option value="before">组开始前</option>
                <option value="active">组有效期内</option>
                <option value="after">组结束后</option>
              </select>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="editBlockFreezeEnabled"
                checked={editBlockFreezeEnabled}
                onCheckedChange={(checked) => setEditBlockFreezeEnabled(checked as boolean)}
              />
              <Label htmlFor="editBlockFreezeEnabled" className="cursor-pointer">
                启用冻结模式（用户看过之后不受时间调整影响）
              </Label>
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <Label>所属区块组</Label>
                <button
                  onClick={() => { setAddingBlockGroup(true); }}
                  className="text-xs text-blue-600 hover:text-blue-800"
                  type="button"
                >
                  + 快速创建
                </button>
              </div>
              <select
                value={editBlockBlockGroupKey}
                onChange={(e) => setEditBlockBlockGroupKey(e.target.value)}
                className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
              >
                <option value="">无分组</option>
                {page?.block_groups?.map((bg) => (
                  <option key={bg.key} value={bg.key}>
                    {bg.name} {bg.mutex ? '(互斥)' : ''}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>开始时间 (可选)</Label>
                <Input
                  type="datetime-local"
                  value={editBlockStartAt}
                  onChange={(e) => setEditBlockStartAt(e.target.value)}
                />
              </div>
              <div>
                <Label>结束时间 (可选)</Label>
                <Input
                  type="datetime-local"
                  value={editBlockEndAt}
                  onChange={(e) => setEditBlockEndAt(e.target.value)}
                />
              </div>
            </div>
            <div>
              <Label>可见用户组</Label>
              <div className="flex flex-wrap gap-2 mt-2">
                {page?.groups.map((group) => (
                  <div key={group.key} className="flex items-center space-x-2">
                    <Checkbox
                      id={`group-${group.key}`}
                      checked={editBlockGroups.includes(group.key)}
                      onCheckedChange={(checked) => {
                        if (checked) {
                          setEditBlockGroups([...editBlockGroups, group.key])
                        } else {
                          setEditBlockGroups(editBlockGroups.filter((g) => g !== group.key))
                        }
                      }}
                    />
                    <label htmlFor={`group-${group.key}`} className="text-sm">
                      {group.name}
                    </label>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between mb-2">
                <Label>按钮</Label>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setEditBlockButtons([...editBlockButtons, { label: '', url_template: '', variant: 'primary', target: '_blank' }])}
                >
                  <Plus className="w-3 h-3 mr-1" />添加按钮
                </Button>
              </div>
              <div className="space-y-2">
                {editBlockButtons.map((btn, idx) => (
                  <div key={idx} className="flex gap-2 items-start">
                    <Input
                      placeholder="按钮文字"
                      value={btn.label}
                      onChange={(e) => {
                        const updated = [...editBlockButtons]
                        updated[idx].label = e.target.value
                        setEditBlockButtons(updated)
                      }}
                      className="flex-1"
                    />
                    <Input
                      placeholder="链接模板, 支持 {{content.xxx}} {{group.name}} {{group.key}}"
                      value={btn.url_template}
                      onChange={(e) => {
                        const updated = [...editBlockButtons]
                        updated[idx].url_template = e.target.value
                        setEditBlockButtons(updated)
                      }}
                      className="flex-1"
                    />
                    <select
                      value={btn.variant}
                      onChange={(e) => {
                        const updated = [...editBlockButtons]
                        updated[idx].variant = e.target.value
                        setEditBlockButtons(updated)
                      }}
                      className="border rounded px-2 py-1 text-sm"
                    >
                      <option value="primary">主按钮</option>
                      <option value="secondary">次按钮</option>
                      <option value="outline">边框</option>
                      <option value="ghost">幽灵</option>
                    </select>
                    <label className="flex items-center gap-1 text-sm whitespace-nowrap">
                      <input
                        type="checkbox"
                        checked={btn.freeze_on_click || false}
                        onChange={(e) => {
                          const updated = [...editBlockButtons]
                          updated[idx].freeze_on_click = e.target.checked
                          setEditBlockButtons(updated)
                        }}
                      />
                      点击冻结
                    </label>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditBlockButtons(editBlockButtons.filter((_, i) => i !== idx))}
                    >
                      <Trash2 className="w-4 h-4 text-red-500" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingBlock(null)}>取消</Button>
            <Button variant="primary" onClick={saveBlockEdit}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Group Dialog */}
      <Dialog open={!!editingGroup} onOpenChange={() => setEditingGroup(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑用户组</DialogTitle>
            <DialogDescription>修改用户组名称和有效期</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div>
              <Label>组名称</Label>
              <Input
                value={editGroupName}
                onChange={(e) => setEditGroupName(e.target.value)}
                placeholder="用户组名称"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>开始时间 (可选)</Label>
                <Input
                  type="datetime-local"
                  value={editGroupStartAt}
                  onChange={(e) => setEditGroupStartAt(e.target.value)}
                />
              </div>
              <div>
                <Label>结束时间 (可选)</Label>
                <Input
                  type="datetime-local"
                  value={editGroupEndAt}
                  onChange={(e) => setEditGroupEndAt(e.target.value)}
                />
              </div>
            </div>
            <div>
              <Label>{'组内容 (JSON)'}</Label>
              <Textarea
                value={editGroupContent}
                onChange={(e) => setEditGroupContent(e.target.value)}
                placeholder='{"url":"https://example.com","description":"VIP组专属链接"}'
                rows={4}
              />
              <p className="text-xs text-gray-500 mt-1">
                {'支持模板变量如 {{group.url}}, {{group.description}}'}
              </p>
            </div>
            {editingGroup && (
              <div>
                <div className="flex items-center justify-between">
                  <Label>组成员</Label>
                  <span className="text-xs text-gray-500">
                    共 {page?.members.filter(m => m.group_key === editingGroup.key).length || 0} 人
                  </span>
                </div>
                <div className="mt-2 border rounded-lg p-3 max-h-48 overflow-y-auto bg-gray-50">
                  {page?.members.filter(m => m.group_key === editingGroup.key).length === 0 ? (
                    <div className="text-sm text-gray-500 text-center py-4">暂无成员</div>
                  ) : (
                    <div className="space-y-1">
                      {page.members
                        .filter(m => m.group_key === editingGroup.key)
                        .slice(0, 50)
                        .map(m => (
                          <div key={m.email} className="text-sm py-1 px-2 hover:bg-white rounded flex items-center justify-between">
                            <span>{m.email}</span>
                            <button
                              onClick={() => handleDeleteMember(m.email)}
                              className="text-red-500 hover:text-red-700 text-xs"
                            >
                              删除
                            </button>
                          </div>
                        ))}
                      {page.members.filter(m => m.group_key === editingGroup.key).length > 50 && (
                        <div className="text-xs text-gray-500 text-center py-2">
                          还有 {page.members.filter(m => m.group_key === editingGroup.key).length - 50} 人...
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingGroup(null)}>取消</Button>
            <Button variant="primary" onClick={saveGroupEdit}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Block Group Dialog */}
      <Dialog open={!!editingBlockGroup} onOpenChange={() => setEditingBlockGroup(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑区块组</DialogTitle>
            <DialogDescription>修改区块组名称和互斥设置</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div>
              <Label>组名称</Label>
              <Input
                value={editBlockGroupName}
                onChange={(e) => setEditBlockGroupName(e.target.value)}
                placeholder="区块组名称"
              />
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="editBlockGroupMutex"
                checked={editBlockGroupMutex}
                onCheckedChange={(checked) => setEditBlockGroupMutex(checked as boolean)}
              />
              <Label htmlFor="editBlockGroupMutex" className="cursor-pointer">
                启用互斥模式（看过组内任一内容后冻结整个组）
              </Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingBlockGroup(null)}>取消</Button>
            <Button variant="primary" onClick={saveBlockGroupEdit}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Member Content Dialog */}
      <Dialog open={!!editingMember} onOpenChange={() => setEditingMember(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>编辑用户内容</DialogTitle>
            <DialogDescription>
              {editingMember?.email} 的个人数据
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div>
              <Label>内容 (JSON)</Label>
              <Textarea
                value={editMemberContent}
                onChange={(e) => setEditMemberContent(e.target.value)}
                placeholder='{"name":"张三","company":"阿里"}'
                rows={10}
                className="font-mono text-sm"
              />
              <p className="text-sm text-gray-500 mt-1">
                支持模板变量如 {"{content.name}"}、{"{content.company}"}
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingMember(null)}>取消</Button>
            <Button variant="primary" onClick={saveMemberContent}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Member Manager Dialog */}
      <Dialog open={showMemberManager} onOpenChange={setShowMemberManager}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle>管理成员</DialogTitle>
            <DialogDescription>
              {(() => {
                const group = page?.groups.find(g => g.key === managingGroupKey)
                return group ? `${group.name} (${managingGroupKey})` : managingGroupKey
              })()}
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-hidden flex flex-col py-4">
            {/* Add Member Form */}
            <div className="border rounded-lg p-3 mb-4 bg-gray-50">
              <div className="flex items-center gap-2 mb-2">
                <UserPlus className="w-4 h-4 text-gray-500" />
                <span className="text-sm font-medium">添加新成员</span>
              </div>
              <div className="flex gap-2">
                <Input
                  placeholder="邮箱地址"
                  value={newMemberEmail}
                  onChange={(e) => setNewMemberEmail(e.target.value)}
                  className="flex-1"
                />
                <Input
                  placeholder='内容JSON {"name":""}'
                  value={newMemberContent}
                  onChange={(e) => setNewMemberContent(e.target.value)}
                  className="w-48"
                />
                <Button size="sm" onClick={handleAddMemberToGroup}>
                  添加
                </Button>
              </div>
            </div>

            {/* Toolbar */}
            <div className="flex items-center gap-4 mb-4">
              <Input
                placeholder="搜索邮箱..."
                value={memberSearchQuery}
                onChange={(e) => {
                  setMemberSearchQuery(e.target.value)
                  setMemberPage(1)
                }}
                className="w-64"
              />
              <div className="flex-1" />
              {selectedMembers.size > 0 && (
                <Button variant="destructive" size="sm" onClick={handleBatchDeleteMembers}>
                  <Trash2 className="w-4 h-4 mr-1" />
                  删除选中 ({selectedMembers.size})
                </Button>
              )}
            </div>

            {/* Member Table */}
            {(() => {
              const groupMembers = page?.members.filter(m => m.group_key === managingGroupKey) || []
              const filtered = groupMembers.filter(m =>
                m.email.toLowerCase().includes(memberSearchQuery.toLowerCase())
              )
              const totalPages = Math.ceil(filtered.length / MEMBERS_PER_PAGE)
              const paginated = filtered.slice(
                (memberPage - 1) * MEMBERS_PER_PAGE,
                memberPage * MEMBERS_PER_PAGE
              )

              return (
                <>
                  <div className="flex-1 overflow-auto border rounded-lg">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50 sticky top-0">
                        <tr>
                          <th className="px-4 py-2 w-10">
                            <Checkbox
                              checked={paginated.length > 0 && paginated.every(m => selectedMembers.has(m.email))}
                              onCheckedChange={(checked) => {
                                const newSelected = new Set(selectedMembers)
                                paginated.forEach(m => {
                                  if (checked) newSelected.add(m.email)
                                  else newSelected.delete(m.email)
                                })
                                setSelectedMembers(newSelected)
                              }}
                            />
                          </th>
                          <th className="px-4 py-2 text-left">邮箱</th>
                          <th className="px-4 py-2 text-left">操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {paginated.map((m) => (
                          <tr key={m.email} className="border-t hover:bg-gray-50">
                            <td className="px-4 py-2">
                              <Checkbox
                                checked={selectedMembers.has(m.email)}
                                onCheckedChange={(checked) => {
                                  const newSelected = new Set(selectedMembers)
                                  if (checked) newSelected.add(m.email)
                                  else newSelected.delete(m.email)
                                  setSelectedMembers(newSelected)
                                }}
                              />
                            </td>
                            <td className="px-4 py-2">{m.email}</td>
                            <td className="px-4 py-2">
                              <div className="flex gap-1">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => {
                                    openEditMember(m)
                                  }}
                                >
                                  <Settings className="w-4 h-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => handleDeleteMember(m.email)}
                                >
                                  <Trash2 className="w-4 h-4 text-red-500" />
                                </Button>
                              </div>
                            </td>
                          </tr>
                        ))}
                        {paginated.length === 0 && (
                          <tr>
                            <td colSpan={3} className="px-4 py-8 text-center text-gray-500">
                              暂无成员
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>

                  {/* Pagination */}
                  {totalPages > 1 && (
                    <div className="flex items-center justify-between mt-4">
                      <div className="text-sm text-gray-500">
                        共 {filtered.length} 人，第 {memberPage}/{totalPages} 页
                      </div>
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={memberPage === 1}
                          onClick={() => setMemberPage(p => Math.max(1, p - 1))}
                        >
                          上一页
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={memberPage === totalPages}
                          onClick={() => setMemberPage(p => Math.min(totalPages, p + 1))}
                        >
                          下一页
                        </Button>
                      </div>
                    </div>
                  )}
                </>
              )
            })()}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowMemberManager(false)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Group Dialog */}
      <Dialog open={addingGroup} onOpenChange={() => setAddingGroup(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>添加用户组</DialogTitle>
            <DialogDescription>创建新的用户分组</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div>
              <Label>组标识</Label>
              <Input
                value={newGroupKey}
                onChange={(e) => setNewGroupKey(e.target.value)}
                placeholder="如: vip"
              />
            </div>
            <div>
              <Label>组名称</Label>
              <Input
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                placeholder="如: VIP用户"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setAddingGroup(false); setNewGroupKey(''); setNewGroupName(''); }}>取消</Button>
            <Button variant="primary" onClick={saveAddGroup}>添加</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Block Group Dialog */}
      <Dialog open={addingBlockGroup} onOpenChange={() => setAddingBlockGroup(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>添加区块组</DialogTitle>
            <DialogDescription>创建新的区块互斥分组</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div>
              <Label>组标识</Label>
              <Input
                value={newBlockGroupKey}
                onChange={(e) => setNewBlockGroupKey(e.target.value)}
                placeholder="如: objective"
              />
            </div>
            <div>
              <Label>组名称</Label>
              <Input
                value={newBlockGroupName}
                onChange={(e) => setNewBlockGroupName(e.target.value)}
                placeholder="如: 客观题"
              />
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="newBlockGroupMutex"
                checked={newBlockGroupMutex}
                onCheckedChange={(checked) => setNewBlockGroupMutex(checked as boolean)}
              />
              <Label htmlFor="newBlockGroupMutex">
                启用互斥模式（看过组内任一内容后冻结整个组）
              </Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setAddingBlockGroup(false); setNewBlockGroupKey(''); setNewBlockGroupName(''); setNewBlockGroupMutex(false); }}>取消</Button>
            <Button variant="primary" onClick={saveAddBlockGroup}>添加</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Block Dialog */}
      <Dialog open={addingBlock} onOpenChange={() => setAddingBlock(false)}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>添加内容区块</DialogTitle>
            <DialogDescription>创建新的页面内容区块</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div>
              <Label>区块标识</Label>
              <Input
                value={newBlockKey}
                onChange={(e) => setNewBlockKey(e.target.value)}
                placeholder="如: welcome"
              />
            </div>
            <div>
              <Label>区块标题</Label>
              <Input
                value={newBlockTitle}
                onChange={(e) => setNewBlockTitle(e.target.value)}
                placeholder="如: 欢迎信息"
              />
            </div>
            <div>
              <Label>Markdown 模板</Label>
              <Textarea
                value={newBlockTemplate}
                onChange={(e) => setNewBlockTemplate(e.target.value)}
                placeholder="支持 {{content.xxx}} 用户变量, {{group.name}} {{group.key}} 组变量"
                rows={4}
              />
              <p className="text-xs text-gray-500 mt-1">
                {'用户变量: {{content.name}}, {{content.company}} 等 | 组变量: {{group.name}}, {{group.key}}, {{group.note}}'}
              </p>
            </div>
            <div>
              <Label>标题字号</Label>
              <select
                value={newBlockFontSize}
                onChange={(e) => setNewBlockFontSize(e.target.value)}
                className="w-full border rounded-md px-3 py-2"
              >
                <option value="small">小 (text-lg)</option>
                <option value="medium">中 (text-xl)</option>
                <option value="large">大 (text-2xl)</option>
                <option value="xlarge">特大 (text-3xl)</option>
              </select>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="newBlockFreezeEnabled"
                checked={newBlockFreezeEnabled}
                onCheckedChange={(checked) => setNewBlockFreezeEnabled(checked as boolean)}
              />
              <Label htmlFor="newBlockFreezeEnabled" className="cursor-pointer">
                启用冻结模式（用户看过之后不受时间调整影响）
              </Label>
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <Label>所属区块组</Label>
                <button
                  onClick={() => { setAddingBlockGroup(true); }}
                  className="text-xs text-blue-600 hover:text-blue-800"
                  type="button"
                >
                  + 快速创建
                </button>
              </div>
              <select
                value={newBlockBlockGroupKey}
                onChange={(e) => setNewBlockBlockGroupKey(e.target.value)}
                className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
              >
                <option value="">无分组</option>
                {page?.block_groups?.map((bg) => (
                  <option key={bg.key} value={bg.key}>
                    {bg.name} {bg.mutex ? '(互斥)' : ''}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <div className="flex items-center justify-between mb-2">
                <Label>按钮</Label>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setNewBlockButtons([...newBlockButtons, { label: '', url_template: '', variant: 'primary', target: '_blank' }])}
                >
                  <Plus className="w-3 h-3 mr-1" />添加按钮
                </Button>
              </div>
              <div className="space-y-2">
                {newBlockButtons.map((btn, idx) => (
                  <div key={idx} className="flex gap-2 items-start">
                    <Input
                      placeholder="按钮文字"
                      value={btn.label}
                      onChange={(e) => {
                        const updated = [...newBlockButtons]
                        updated[idx].label = e.target.value
                        setNewBlockButtons(updated)
                      }}
                      className="flex-1"
                    />
                    <Input
                      placeholder="链接模板, 支持 {{content.xxx}} {{group.name}} {{group.key}}"
                      value={btn.url_template}
                      onChange={(e) => {
                        const updated = [...newBlockButtons]
                        updated[idx].url_template = e.target.value
                        setNewBlockButtons(updated)
                      }}
                      className="flex-1"
                    />
                    <select
                      value={btn.variant}
                      onChange={(e) => {
                        const updated = [...newBlockButtons]
                        updated[idx].variant = e.target.value
                        setNewBlockButtons(updated)
                      }}
                      className="border rounded px-2 py-1 text-sm"
                    >
                      <option value="primary">主按钮</option>
                      <option value="secondary">次按钮</option>
                      <option value="outline">边框</option>
                      <option value="ghost">幽灵</option>
                    </select>
                    <label className="flex items-center gap-1 text-sm whitespace-nowrap">
                      <input
                        type="checkbox"
                        checked={btn.freeze_on_click || false}
                        onChange={(e) => {
                          const updated = [...newBlockButtons]
                          updated[idx].freeze_on_click = e.target.checked
                          setNewBlockButtons(updated)
                        }}
                      />
                      点击冻结
                    </label>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setNewBlockButtons(newBlockButtons.filter((_, i) => i !== idx))}
                    >
                      <Trash2 className="w-4 h-4 text-red-500" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddingBlock(false)}>取消</Button>
            <Button variant="primary" onClick={saveAddBlock}>添加</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
