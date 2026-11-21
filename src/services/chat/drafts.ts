import { create } from 'zustand'
import type { TranslationMessage } from '../../i18n/index.js'
import { createId } from '../../utils/id.js'
import {
  cancelUpload,
  isImage,
  resolveMimeType,
  uploadAttachment,
  validateFiles,
  type UploadTask,
} from '../attachments.js'
import type { FileAttachment } from './types.js'
import type { ProviderProfile } from '../providers.js'
import { loadFile, loadWorkspaceValues, saveWorkspaceValue } from './db.js'

export type DraftAttachment = {
  /** 本地标识，也是 IndexedDB 原件与上传任务的 key */
  id: string
  file: File
  isImage: boolean
}

type Draft = { text: string; attachments: DraftAttachment[] }

export const EMPTY_DRAFT: Draft = { text: '', attachments: [] }

/** 草稿独立于会话详情缓存。null 是新对话的草稿。 */
export const useDrafts = create<{ drafts: Map<string | null, Draft> }>(() => ({
  drafts: new Map(),
}))

export const getDraft = (sessionId: string | null): Draft =>
  useDrafts.getState().drafts.get(sessionId) ?? EMPTY_DRAFT

const updateDraft = (sessionId: string | null, update: (draft: Draft) => Draft) =>
  useDrafts.setState((state) => {
    const draft = update(state.drafts.get(sessionId) ?? EMPTY_DRAFT)
    const drafts = new Map(state.drafts)
    if (draft.text || draft.attachments.length > 0) {
      drafts.set(sessionId, draft)
    } else {
      drafts.delete(sessionId)
    }
    return { drafts }
  })

export const setDraftText = (sessionId: string | null, text: string) =>
  updateDraft(sessionId, (draft) => ({ ...draft, text }))

const upload = (attachment: DraftAttachment, connection: ProviderProfile) => {
  // 上传任务负责记录错误，输入框的附件卡片展示失败及重试入口。
  void uploadAttachment(
    connection,
    attachment.id,
    attachment.file,
    attachment.file.name,
    attachment.isImage
  ).catch(() => {})
}

/** 整批校验通过后才加入草稿并开始上传。 */
export const addDraftFiles = (
  sessionId: string | null,
  files: File[],
  connection: ProviderProfile
): TranslationMessage | null => {
  if (files.length === 0) {
    return null
  }
  const error = validateFiles(files, getDraft(sessionId).attachments.length)
  if (error) {
    return error
  }
  const added = files.map(
    (file): DraftAttachment => ({
      id: createId(),
      file,
      isImage: isImage(resolveMimeType(file)),
    })
  )
  updateDraft(sessionId, (draft) => ({ ...draft, attachments: [...draft.attachments, ...added] }))
  added.forEach((attachment) => upload(attachment, connection))
  return null
}

export const retryDraftAttachment = (
  sessionId: string | null,
  attachmentId: string,
  connection: ProviderProfile
) => {
  const attachment = getDraft(sessionId).attachments.find((item) => item.id === attachmentId)
  if (attachment) {
    upload(attachment, connection)
  }
}

/** 发送按钮和实际提交共用规则：有内容，且全部附件已上传成功。 */
export const prepareDraftMessage = (draft: Draft, tasks: Record<string, UploadTask>) => {
  const text = draft.text.trim()
  if (!text && draft.attachments.length === 0) {
    return null
  }
  const files: (FileAttachment & { serverId: string; blob: Blob })[] = []
  for (const attachment of draft.attachments) {
    const task = tasks[attachment.id]
    if (task?.status !== 'done' || !task.serverId) {
      return null
    }
    files.push({
      id: attachment.id,
      serverId: task.serverId,
      connectionScope: task.scope,
      name: attachment.file.name,
      size: attachment.file.size,
      isImage: attachment.isImage,
      mimeType: resolveMimeType(attachment.file),
      blob: attachment.file,
    })
  }
  return { text, files }
}

export const removeDraftAttachment = (sessionId: string | null, attachmentId: string) => {
  const attachment = getDraft(sessionId).attachments.find((item) => item.id === attachmentId)
  if (!attachment) {
    return
  }
  cancelUpload(attachment.id)
  updateDraft(sessionId, (draft) => ({
    ...draft,
    attachments: draft.attachments.filter((item) => item.id !== attachmentId),
  }))
}

/** 发送成功后原件与 serverId 已交给会话，保留上传完成态。 */
export const clearSentDraft = (sessionId: string | null) => {
  updateDraft(sessionId, () => EMPTY_DRAFT)
}

/** 删除会话或替换历史成功后，释放尚未发送的草稿及上传任务。 */
export const clearDraft = (sessionId: string | null) => {
  getDraft(sessionId).attachments.forEach((attachment) => cancelUpload(attachment.id))
  updateDraft(sessionId, () => EMPTY_DRAFT)
}

export const clearAllDrafts = () => {
  for (const draft of useDrafts.getState().drafts.values()) {
    draft.attachments.forEach((attachment) => cancelUpload(attachment.id))
  }
  useDrafts.setState({ drafts: new Map() })
}

const newDraft = ':new-chat'
type DraftFileRecord = { id: string; name: string; type: string; lastModified: number; isImage: boolean }
type DraftRecovery = { id: string; text: string; attachmentCount: number }
export const useDraftRecovery = create(() => ({ copies: [] as DraftRecovery[] }))

const describeDraftFiles = (draft: Draft): DraftFileRecord[] => draft.attachments.map(({ id, file, isImage }) => ({
  id, name: file.name, type: file.type, lastModified: file.lastModified, isImage,
}))

const draftFileRecords = (value: unknown): DraftFileRecord[] => {
  if (!Array.isArray(value)) throw new Error('Invalid draft attachments')
  for (const file of value) {
    if (!file || typeof file.id !== 'string' || typeof file.name !== 'string' ||
        typeof file.type !== 'string' || typeof file.isImage !== 'boolean' || !Number.isFinite(file.lastModified))
      throw new Error('Invalid draft attachment')
  }
  return value
}

const restoreDraftFiles = async (storage: string | null, records: DraftFileRecord[], before: Draft) => {
  const restored: DraftAttachment[] = []
  for (const file of records) {
    const existing = before.attachments.find((attachment) => attachment.id === file.id)
    if (existing) {
      restored.push(existing)
    } else {
      const original = await loadFile(file.id, storage)
      if (!original) return undefined
      restored.push({
        id: file.id,
        file: new File([original], file.name, { type: file.type, lastModified: file.lastModified }),
        isImage: file.isImage,
      })
    }
  }
  return restored
}

export const recoverWorkspaceDraft = async (storage: string, id: string) => {
  const rows = await loadWorkspaceValues(storage, 'drafts')
  const record = rows.find((entry) => entry.id === id)?.value
  if (!record || typeof record.text !== 'string' || typeof record.conflictOf !== 'string')
    throw new Error('The draft copy is unavailable')
  const current = getDraft(null)
  const files = await restoreDraftFiles(storage, draftFileRecords(record.attachments), current)
  if (!files || getDraft(null) !== current) throw new Error('Draft data changed while loading')
  const merged = {
    text: [current.text, record.text].filter(Boolean).join('\n\n'),
    attachments: [...current.attachments, ...files.filter((file) => !current.attachments.some(({ id }) => id === file.id))],
  }
  const attachments = describeDraftFiles(merged)
  // Keep the recovered source until the merged draft is safely committed.
  await saveWorkspaceValue(storage, 'drafts', newDraft, { text: merged.text, attachments })
  await saveWorkspaceValue(storage, 'drafts', id, null)
  useDraftRecovery.setState(({ copies }) => ({ copies: copies.filter((copy) => copy.id !== id) }))
  updateDraft(null, () => merged)
}

export const bindWorkspaceDrafts = (storage: string, onError: () => void) => {
  let applying = false
  let stopped = false
  const writes = new Map<string, Promise<void>>()
  const unsubscribe = useDrafts.subscribe(({ drafts }, before) => {
    if (applying) return
    for (const id of new Set([...drafts.keys(), ...before.drafts.keys()])) {
      const draft = drafts.get(id)
      if (draft === before.drafts.get(id)) continue
      const key = id ?? newDraft
      const pending = writes.get(key) ?? Promise.resolve()
      const task = pending.catch(() => {}).then(() => saveWorkspaceValue(
        storage,
        'drafts',
        key,
        draft ? { text: draft.text, attachments: describeDraftFiles(draft) } : null,
        draft?.attachments.map(({ id: fileId, file }) => ({ id: fileId, blob: file }))
      ))
      writes.set(key, task)
      void task.then(() => {
        if (writes.get(key) === task) writes.delete(key)
      }, onError)
    }
  })
  return {
    async restore() {
      const before = useDrafts.getState().drafts
      const rows = await loadWorkspaceValues(storage, 'drafts')
      const names = new Set<string>()
      const copies: DraftRecovery[] = []
      const updates = new Map<string | null, Draft>()
      for (const { id, value } of rows) {
        names.add(id)
        if (typeof value.text !== 'string') throw new Error('Invalid workspace draft')
        const records = draftFileRecords(value.attachments)
        if (typeof value.conflictOf === 'string') {
          copies.push({ id, text: value.text, attachmentCount: records.length })
        } else if (!writes.has(id)) {
          const key = id === newDraft ? null : id
          const previous = before.get(key) ?? EMPTY_DRAFT
          if (previous.text === value.text && JSON.stringify(describeDraftFiles(previous)) === JSON.stringify(records)) continue
          const attachments = await restoreDraftFiles(storage, records, previous)
          if (attachments) updates.set(key, { text: value.text, attachments })
        }
      }
      if (stopped) return
      useDraftRecovery.setState({ copies })
      applying = true
      try {
        for (const [id, draft] of before) {
          if (!names.has(id ?? newDraft) && !writes.has(id ?? newDraft) && getDraft(id) === draft) clearDraft(id)
        }
        for (const [id, draft] of updates) {
          const previous = getDraft(id)
          if (writes.has(id ?? newDraft) || previous !== (before.get(id) ?? EMPTY_DRAFT)) continue
          for (const item of previous.attachments) {
            if (!draft.attachments.includes(item)) cancelUpload(item.id)
          }
          updateDraft(id, () => draft)
        }
      } finally {
        applying = false
      }
    },
    async flush() { await Promise.all(writes.values()) },
    stop() {
      stopped = true
      unsubscribe()
    },
  }
}
