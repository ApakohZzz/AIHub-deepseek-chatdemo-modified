import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from 'idb'
import { toSessionSummary, type Session, type SessionSummary } from './types.js'

const legacyDatabaseVersion = 11
const workspaceDatabaseVersion = 1

/** 文件原件按附件的本地 id 存储，所有引用同一 id 的消息共用一份；用于缩略图、打开查看，以及没有 serverId 时补传。 */
export type StoredFile = {
  id: string
  blob: Blob
}

/** 文件引用留在摘要中，删除会话时通过索引判断原件是否仍被引用。 */
type StoredSessionSummary = SessionSummary & { fileIds: string[] }

export type WorkspaceKind = 'sessions' | 'files' | 'settings' | 'drafts'
export type WorkspaceValue = Session | Blob | Record<string, unknown>
export type WorkspaceChange = {
  kind: WorkspaceKind
  id: string
  revision: number
  deleted: boolean
}
export type WorkspaceMutation = Omit<WorkspaceChange, 'revision'> & {
  key: string
  baseRevision: number
  mutation: string
}

type SyncVersion = { key: string; revision: number }
type SyncValue = { key: string; value: Record<string, unknown> }
const recordKey = (kind: WorkspaceKind, id: string) => `${kind}:${id}`
const valueRange = (kind: 'settings' | 'drafts') => IDBKeyRange.bound(`${kind}:`, `${kind};`, false, true)

const draftFileIds = (value: Record<string, unknown> | undefined): string[] =>
  Array.isArray(value?.attachments)
    ? value.attachments.flatMap((file) => typeof file?.id === 'string' ? [file.id] : [])
    : []

interface ChatDB extends DBSchema {
  /** 当前使用的会话，界面读写都在这里 */
  sessions: { key: string; value: Session }
  sessionSummaries: {
    key: string
    value: StoredSessionSummary
    indexes: { fileIds: string }
  }
  /** 当前使用的文件原件 */
  files: { key: string; value: StoredFile }
  /**
   * 历史导入的暂存：导入过程中会话与原件只写入这两个存储，`sessions` / `files` 保持不变；
   * 全部校验通过后在一个事务中替换正式数据并清空暂存，失败时只清空暂存。
   */
  sessionsStaging: { key: string; value: Session }
  filesStaging: { key: string; value: StoredFile }
  syncVersions: { key: string; value: SyncVersion }
  syncMutations: { key: string; value: WorkspaceMutation }
  syncValues: { key: string; value: SyncValue }
}

let activeWorkspace: string | null = null
const databases = new Map<string | null, Promise<IDBPDatabase<ChatDB>>>()

export const setChatWorkspace = (workspace: string | null) => {
  activeWorkspace = workspace
}

export const getChatStorage = () => activeWorkspace
export const localAccountStorage = (workspace: string) => `local:${workspace}`
const syncsToAccount = (storage: string | null) => storage !== null && !storage.startsWith('local:')
const syncStores = ['syncMutations', 'syncVersions'] as const

const storedSummary = (session: Session): StoredSessionSummary => ({
  ...toSessionSummary(session),
  fileIds: [
    ...new Set(
      session.messages.flatMap((message) =>
        message.role === 'user' ? message.files.map((file) => file.id) : []
      )
    ),
  ],
})

const abortTransaction = (tx: { abort(): void }) => {
  try {
    tx.abort()
  } catch {
    // 事务已因请求失败中止。
  }
}

// 每个操作拿到连接后立即创建事务；IndexedDB 按创建顺序执行范围重叠的事务，读取总能看到之前发起的写入。
const getDB = (workspace = activeWorkspace) => {
  const existing = databases.get(workspace)
  if (existing) return existing
  const name = workspace === null ? 'chat-demo' : `ai-hub:workspace:${workspace}`
  const connection = openDB<ChatDB>(name, workspace === null ? legacyDatabaseVersion : workspaceDatabaseVersion, {
    upgrade(db, _oldVersion, _newVersion, tx) {
      // 初始化当前格式需要的存储与索引，不迁移旧消息。
      for (const name of ['sessions', 'files', 'sessionsStaging', 'filesStaging'] as const) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: 'id' })
        }
      }
      const summaries = db.objectStoreNames.contains('sessionSummaries')
        ? tx.objectStore('sessionSummaries')
        : db.createObjectStore('sessionSummaries', { keyPath: 'id' })
      if (!summaries.indexNames.contains('fileIds')) {
        summaries.createIndex('fileIds', 'fileIds', { multiEntry: true })
      }
      if (workspace !== null) {
        for (const name of [...syncStores, 'syncValues'] as const) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'key' })
        }
      }
    },
    blocking() {
      databases.delete(workspace)
      void connection.then((db) => db.close())
    },
    terminated() {
      databases.delete(workspace)
    },
  }).catch((error: unknown) => {
    databases.delete(workspace)
    throw error
  })
  databases.set(workspace, connection)
  return connection
}

type SyncTransaction = {
  versions: Pick<ChatDBConnectionStore<'syncVersions'>, 'get'>
  mutations: Pick<ChatDBConnectionStore<'syncMutations'>, 'get' | 'put'>
}
type ChatDBConnectionStore<Name extends keyof ChatDB> = {
  get(key: string): Promise<ChatDB[Name]['value'] | undefined>
  put(value: ChatDB[Name]['value']): Promise<string>
}

const markChanged = async (tx: SyncTransaction, kind: WorkspaceKind, id: string, deleted = false) => {
  const key = recordKey(kind, id)
  const existing = await tx.mutations.get(key)
  const baseRevision = existing?.baseRevision ?? (await tx.versions.get(key))?.revision ?? 0
  await tx.mutations.put({ key, kind, id, deleted, baseRevision, mutation: crypto.randomUUID() })
}

export const loadSessionSummaries = async (): Promise<SessionSummary[]> =>
  (await (await getDB()).getAll('sessionSummaries')).map(toSessionSummary)

export const loadSession = async (id: string): Promise<Session | undefined> =>
  (await getDB()).get('sessions', id)

export const saveSession = async (session: Session, files: StoredFile[] = []): Promise<void> => {
  const workspace = activeWorkspace
  const synced = syncsToAccount(workspace)
  const tx = (await getDB(workspace)).transaction(
    ['sessions', 'sessionSummaries', 'files', ...(synced ? syncStores : [])] as const, 'readwrite'
  )
  const sync = synced ? { mutations: tx.objectStore('syncMutations'), versions: tx.objectStore('syncVersions') } : null
  await Promise.all([
    (async () => {
      try {
        const summaries = tx.objectStore('sessionSummaries')
        const existing = await summaries.get(session.id)
        // 置顶由列表事务管理，旧的流式回复快照不能覆盖已写入的置顶状态。
        const saved = { ...session, pinned: existing?.pinned ?? session.pinned }
        for (const file of files) {
          await tx.objectStore('files').put(file)
          if (sync) await markChanged(sync, 'files', file.id)
        }
        await tx.objectStore('sessions').put(saved)
        await summaries.put(storedSummary(saved))
        if (sync) await markChanged(sync, 'sessions', session.id)
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

/** 未打开的会话也可重命名，只读取该会话，原子更新详情和列表。 */
export const renameSession = async (id: string, title: string): Promise<void> => {
  const workspace = activeWorkspace
  const synced = syncsToAccount(workspace)
  const tx = (await getDB(workspace)).transaction(
    ['sessions', 'sessionSummaries', ...(synced ? syncStores : [])] as const, 'readwrite'
  )
  const sync = synced ? { mutations: tx.objectStore('syncMutations'), versions: tx.objectStore('syncVersions') } : null
  await Promise.all([
    (async () => {
      try {
        const sessions = tx.objectStore('sessions')
        const summaries = tx.objectStore('sessionSummaries')
        const session = await sessions.get(id)
        if (session) {
          const summary = await summaries.get(id)
          session.title = title
          await sessions.put(session)
          await summaries.put(summary ? { ...summary, title } : storedSummary(session))
          if (sync) await markChanged(sync, 'sessions', id)
        }
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

/** 置顶是摘要属性，批量操作在同一事务内提交。 */
export const setSessionsPinned = async (
  ids: ReadonlySet<string>,
  pinned: boolean
): Promise<void> => {
  const workspace = activeWorkspace
  const synced = syncsToAccount(workspace)
  const tx = (await getDB(workspace)).transaction(
    ['sessionSummaries', ...(synced ? syncStores : [])] as const, 'readwrite'
  )
  const summaries = tx.objectStore('sessionSummaries')
  const sync = synced ? { mutations: tx.objectStore('syncMutations'), versions: tx.objectStore('syncVersions') } : null
  await Promise.all([
    (async () => {
      try {
        for (const id of ids) {
          const summary = await summaries.get(id)
          if (!summary) {
            throw new Error('Cannot pin a session that is not saved locally')
          }
          if (summary.pinned === pinned) continue
          await summaries.put({ ...summary, pinned })
          if (sync) await markChanged(sync, 'sessions', id)
        }
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

/** 原子删除会话，仅清理已无会话引用的本地原件。 */
export const deleteSessions = async (ids: ReadonlySet<string>): Promise<void> => {
  const workspace = activeWorkspace
  const synced = syncsToAccount(workspace)
  const localScope = workspace !== null && !synced
  const tx = (await getDB(workspace)).transaction(
    ['sessions', 'sessionSummaries', 'files', ...(localScope ? ['syncValues'] as const : []), ...(synced ? syncStores : [])] as const, 'readwrite'
  )
  const sync = synced ? { mutations: tx.objectStore('syncMutations'), versions: tx.objectStore('syncVersions') } : null
  await Promise.all([
    (async () => {
      try {
        const summaries = tx.objectStore('sessionSummaries')
        const candidates = new Set<string>()
        for (const id of ids) {
          const summary = await summaries.get(id)
          for (const fileId of summary?.fileIds ?? []) {
            candidates.add(fileId)
          }
          await tx.objectStore('sessions').delete(id)
          await summaries.delete(id)
          if (sync && summary) await markChanged(sync, 'sessions', id, true)
        }
        if (!synced && candidates.size) {
          const drafts = localScope ? await tx.objectStore('syncValues').getAll(valueRange('drafts')) : []
          const draftReferences = new Set(drafts.flatMap(({ value }) => draftFileIds(value)))
          for (const id of candidates) {
            if (!draftReferences.has(id) && (await summaries.index('fileIds').count(id)) === 0) {
              await tx.objectStore('files').delete(id)
            }
          }
        }
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

const putFiles = async (store: 'files' | 'filesStaging', files: StoredFile[]) => {
  const tx = (await getDB()).transaction(store, 'readwrite')
  await Promise.all([...files.map((file) => tx.store.put(file)), tx.done])
}

export const saveFiles = (files: StoredFile[]): Promise<void> => putFiles('files', files)

export const loadFile = async (id: string, storage = activeWorkspace): Promise<Blob | undefined> =>
  (await (await getDB(storage)).get('files', id))?.blob

/** 清空导入暂存：开始导入前清除上次中断（如关闭页面）遗留的数据，导入失败后清除本次写入。 */
export const clearStaging = async (): Promise<void> => {
  const tx = (await getDB()).transaction(['sessionsStaging', 'filesStaging'], 'readwrite')
  await Promise.all([
    tx.objectStore('sessionsStaging').clear(),
    tx.objectStore('filesStaging').clear(),
    tx.done,
  ])
}

export const addStagingSession = async (session: Session): Promise<void> => {
  await (await getDB()).add('sessionsStaging', session)
}

export const saveStagingFiles = (files: StoredFile[]): Promise<void> =>
  putFiles('filesStaging', files)

/** 图片位于会话 JSON 之后；全部读完后回填具体 MIME，保留归档给出的 isImage 标识。 */
export const updateStagingFileTypes = async (types: ReadonlyMap<string, string>): Promise<void> => {
  const tx = (await getDB()).transaction('sessionsStaging', 'readwrite')
  await Promise.all([
    (async () => {
      for (let cursor = await tx.store.openCursor(); cursor; cursor = await cursor.continue()) {
        const session = cursor.value
        let changed = false
        for (const message of session.messages) {
          if (message.role !== 'user') {
            continue
          }
          for (const file of message.files) {
            const type = types.get(file.id) ?? ''
            if (file.mimeType !== type) {
              file.mimeType = type
              changed = true
            }
          }
        }
        if (changed) {
          await cursor.update(session)
        }
      }
    })(),
    tx.done,
  ])
}

/**
 * 导入完成后用暂存替换正式数据：同一事务中替换会话、摘要和原件，并清空暂存。
 * 逐条游标复制，同一时间只读取一条记录；事务失败时整体回滚，正式数据不变。
 */
export const commitStaging = async (): Promise<SessionSummary[]> => {
  const summaries: SessionSummary[] = []
  const workspace = activeWorkspace
  const synced = syncsToAccount(workspace)
  const tx = (await getDB(workspace)).transaction(
    ['sessions', 'sessionSummaries', 'files', 'sessionsStaging', 'filesStaging', ...(synced ? syncStores : [])] as const,
    'readwrite'
  )
  const sync = synced ? { mutations: tx.objectStore('syncMutations'), versions: tx.objectStore('syncVersions') } : null
  const previous = sync ? new Set(await tx.objectStore('sessionSummaries').getAllKeys()) : null
  const move = async (from: 'sessionsStaging' | 'filesStaging', to: 'sessions' | 'files') => {
    try {
      const target = tx.objectStore(to)
      // An account's originals can still be needed by a queued change or a draft.
      if (!synced || to === 'sessions') await target.clear()
      if (to === 'sessions') {
        await tx.objectStore('sessionSummaries').clear()
      }
      for (
        let cursor = await tx.objectStore(from).openCursor();
        cursor;
        cursor = await cursor.continue()
      ) {
        await target.put(cursor.value)
        if (to === 'sessions') {
          const summary = storedSummary(cursor.value as Session)
          await tx.objectStore('sessionSummaries').put(summary)
          summaries.push(toSessionSummary(summary))
        }
        if (sync) await markChanged(sync, to, cursor.value.id)
        if (to === 'sessions') previous?.delete(cursor.value.id)
      }
      await tx.objectStore(from).clear()
    } catch (error) {
      // 同步抛出的错误不会让事务自动回滚，需显式中止，避免只提交清空和部分移入。
      abortTransaction(tx)
      throw error
    }
  }
  const replace = async () => {
    await Promise.all([move('sessionsStaging', 'sessions'), move('filesStaging', 'files')])
    if (sync && previous) {
      for (const id of previous) await markChanged(sync, 'sessions', id, true)
    }
  }
  await Promise.all([replace(), tx.done])
  // 直接返回本次提交的列表，调用方无需在替换成功后再发起可能失败的读取。
  return summaries
}

export const listWorkspaceMutations = async (workspace: string) =>
  (await getDB(workspace)).getAll('syncMutations')

export const readWorkspaceMutation = async (
  workspace: string,
  pending: WorkspaceMutation
): Promise<{ value: WorkspaceValue | null } | undefined> => {
  const tx = (await getDB(workspace)).transaction(
    ['sessions', 'sessionSummaries', 'files', 'syncValues', 'syncMutations'], 'readonly'
  )
  const read = async () => {
    const current = await tx.objectStore('syncMutations').get(pending.key)
    if (current?.mutation !== pending.mutation) return undefined
    if (pending.deleted) return { value: null }
    let value
    if (pending.kind === 'sessions') {
      const session = await tx.objectStore('sessions').get(pending.id)
      const summary = await tx.objectStore('sessionSummaries').get(pending.id)
      if (session && summary) value = { ...session, ...toSessionSummary(summary) }
    } else if (pending.kind === 'files') {
      value = (await tx.objectStore('files').get(pending.id))?.blob
    } else {
      value = (await tx.objectStore('syncValues').get(pending.key))?.value
    }
    if (!value) throw new Error(`Missing local workspace ${pending.kind} record`)
    return { value }
  }
  const [record] = await Promise.all([read(), tx.done])
  return record
}

export const acknowledgeWorkspaceMutation = async (
  workspace: string,
  sent: WorkspaceMutation,
  revision: number
) => {
  const tx = (await getDB(workspace)).transaction(['syncVersions', 'syncMutations'], 'readwrite')
  const versions = tx.objectStore('syncVersions')
  const mutations = tx.objectStore('syncMutations')
  const finish = async () => {
    const current = await mutations.get(sent.key)
    const previous = await versions.get(sent.key)
    if (revision > (previous?.revision ?? 0)) await versions.put({ key: sent.key, revision })
    if (current?.mutation === sent.mutation) await mutations.delete(sent.key)
    else if (current && current.baseRevision === sent.baseRevision)
      await mutations.put({ ...current, baseRevision: revision })
  }
  await Promise.all([finish(), tx.done])
}

const cursorKey = 'changes-cursor'
export const readWorkspaceCursor = async (workspace: string) =>
  (await (await getDB(workspace)).get('syncVersions', cursorKey))?.revision ?? 0

export const advanceWorkspaceCursor = async (workspace: string, revision: number) => {
  const tx = (await getDB(workspace)).transaction('syncVersions', 'readwrite')
  const advance = async () => {
    const current = await tx.store.get(cursorKey)
    if (revision > (current?.revision ?? 0)) await tx.store.put({ key: cursorKey, revision })
  }
  await Promise.all([advance(), tx.done])
}

export const workspaceRecordState = async (workspace: string, change: WorkspaceChange) => {
  const key = recordKey(change.kind, change.id)
  const tx = (await getDB(workspace)).transaction(['syncVersions', 'syncMutations'], 'readonly')
  const [known, pending] = await Promise.all([
    tx.objectStore('syncVersions').get(key),
    tx.objectStore('syncMutations').get(key),
    tx.done,
  ])
  if ((known?.revision ?? 0) >= change.revision) return 'known'
  return pending ? 'pending' : 'new'
}

const workspaceStores = ['syncVersions', 'syncMutations', 'syncValues', 'sessions', 'sessionSummaries', 'files'] as const
type WorkspaceTransaction = IDBPTransaction<ChatDB, typeof workspaceStores, 'readwrite'>

const writeWorkspaceRecord = async (
  tx: WorkspaceTransaction,
  kind: WorkspaceKind,
  id: string,
  value: WorkspaceValue | null
) => {
  const key = recordKey(kind, id)
  if (kind === 'sessions') {
    if (value === null) {
      await tx.objectStore('sessions').delete(id)
      await tx.objectStore('sessionSummaries').delete(id)
    } else {
      const session = value as Session
      await tx.objectStore('sessions').put(session)
      await tx.objectStore('sessionSummaries').put(storedSummary(session))
    }
  } else if (kind === 'files') {
    if (value === null) await tx.objectStore('files').delete(id)
    else await tx.objectStore('files').put({ id, blob: value as Blob })
  } else if (value === null) {
    await tx.objectStore('syncValues').delete(key)
  } else {
    await tx.objectStore('syncValues').put({ key, value: value as Record<string, unknown> })
  }
}

export const applyWorkspaceChange = async (
  workspace: string,
  change: WorkspaceChange,
  value: WorkspaceValue | null
) => {
  const { kind, id, revision } = change
  const key = recordKey(kind, id)
  const tx = (await getDB(workspace)).transaction(workspaceStores, 'readwrite')
  const apply = async () => {
    const versions = tx.objectStore('syncVersions')
    if (((await versions.get(key))?.revision ?? 0) >= revision) return 'known'
    if (await tx.objectStore('syncMutations').get(key)) return 'pending'
    await writeWorkspaceRecord(tx, kind, id, value)
    await versions.put({ key, revision })
    return 'applied'
  }
  const [result] = await Promise.all([apply().catch((error: unknown) => {
    abortTransaction(tx)
    throw error
  }), tx.done])
  return result
}

export const resolveWorkspaceConflict = async (
  workspace: string,
  pending: WorkspaceMutation,
  revision: number,
  remote: WorkspaceValue | null,
  local: WorkspaceValue | null,
  conflictTitle: (title: string) => string
) => {
  const tx = (await getDB(workspace)).transaction(workspaceStores, 'readwrite')
  const versions = tx.objectStore('syncVersions')
  const mutations = tx.objectStore('syncMutations')
  const sync = { versions, mutations }
  const resolve = async () => {
    const current = await mutations.get(pending.key)
    if (current?.mutation !== pending.mutation) return false
    const { key, kind, id } = pending
    await versions.put({ key, revision })
    if (kind === 'settings' || (kind === 'files' && remote === null && local instanceof Blob)) {
      // Settings use independent keys, so changing one preference never rolls back another.
      await mutations.put({ ...current, baseRevision: revision, mutation: crypto.randomUUID() })
      return false
    }
    if (local !== null) {
      const copyId = crypto.randomUUID()
      if (kind === 'sessions') {
        const session = local as Session
        await writeWorkspaceRecord(tx, kind, copyId, { ...session, id: copyId, title: conflictTitle(session.title) })
      } else if (kind === 'drafts') {
        await writeWorkspaceRecord(tx, kind, copyId, { ...local, conflictOf: id })
      } else {
        throw new Error('An attachment with this ID already exists in the workspace')
      }
      await markChanged(sync, kind, copyId)
    }
    await writeWorkspaceRecord(tx, kind, id, remote)
    await mutations.delete(key)
    return true
  }
  const [changed] = await Promise.all([resolve().catch((error: unknown) => {
    abortTransaction(tx)
    throw error
  }), tx.done])
  return changed
}

export const saveWorkspaceValue = async (
  workspace: string,
  kind: 'settings' | 'drafts',
  id: string,
  value: Record<string, unknown> | null,
  files: StoredFile[] = []
) => {
  const key = recordKey(kind, id)
  const synced = syncsToAccount(workspace)
  const tx = (await getDB(workspace)).transaction(
    ['syncValues', 'syncVersions', 'syncMutations', 'files', 'sessionSummaries'], 'readwrite'
  )
  const sync = { mutations: tx.objectStore('syncMutations'), versions: tx.objectStore('syncVersions') }
  const save = async () => {
    for (const file of files) {
      if (!(await tx.objectStore('files').getKey(file.id))) {
        await tx.objectStore('files').put(file)
        if (synced) await markChanged(sync, 'files', file.id)
      }
    }
    const values = tx.objectStore('syncValues')
    const previous = !synced && kind === 'drafts' ? await values.get(key) : undefined
    if (value === null) await values.delete(key)
    else await values.put({ key, value })
    if (synced) await markChanged(sync, kind, id, value === null)
    if (previous) {
      const removed = new Set(draftFileIds(previous.value))
      for (const file of await values.getAll(valueRange('drafts'))) {
        for (const id of draftFileIds(file.value)) removed.delete(id)
      }
      const references = tx.objectStore('sessionSummaries').index('fileIds')
      for (const id of removed) {
        if ((await references.count(id)) === 0) await tx.objectStore('files').delete(id)
      }
    }
  }
  await Promise.all([save().catch((error: unknown) => {
    abortTransaction(tx)
    throw error
  }), tx.done])
}

export const loadWorkspaceValues = async (workspace: string, kind: 'settings' | 'drafts') => {
  const rows = await (await getDB(workspace)).getAll('syncValues', valueRange(kind))
  return rows.map(({ key, value }) => ({ id: key.slice(kind.length + 1), value }))
}

export const countStoredSessions = async (storage: string | null) =>
  (await getDB(storage)).count('sessionSummaries')

export async function* readStoredSessions(storage: string | null): AsyncGenerator<Session> {
  const db = await getDB(storage)
  const ids = await db.getAllKeys('sessionSummaries')
  for (const id of ids) {
    const tx = db.transaction(['sessions', 'sessionSummaries'], 'readonly')
    const [session, summary] = await Promise.all([
      tx.objectStore('sessions').get(id), tx.objectStore('sessionSummaries').get(id), tx.done,
    ])
    if (session && summary) yield { ...session, ...toSessionSummary(summary) }
  }
}

export const mergeStoredSession = async (
  storage: string,
  original: Session,
  copy: Session,
  files: StoredFile[]
) => {
  const tx = (await getDB(storage)).transaction(workspaceStores, 'readwrite')
  const sessions = tx.objectStore('sessions')
  const summaries = tx.objectStore('sessionSummaries')
  const sync = { mutations: tx.objectStore('syncMutations'), versions: tx.objectStore('syncVersions') }
  const same = async (session: Session) => {
    const existing = await sessions.get(session.id)
    const summary = await summaries.get(session.id)
    return Boolean(existing && summary && JSON.stringify({ ...existing, ...toSessionSummary(summary) }) === JSON.stringify(session))
  }
  const merge = async () => {
    for (const file of files) {
      if (await tx.objectStore('files').getKey(file.id)) continue
      await tx.objectStore('files').put(file)
      if (syncsToAccount(storage)) await markChanged(sync, 'files', file.id)
    }
    if (await same(original) || await same(copy)) return false
    const key = recordKey('sessions', original.id)
    const occupied = await sessions.getKey(original.id) || await sync.versions.get(key) || await sync.mutations.get(key)
    const session = occupied ? copy : original
    if (await sessions.getKey(session.id)) throw new Error('A migrated conversation ID is already in use')
    await writeWorkspaceRecord(tx, 'sessions', session.id, session)
    if (syncsToAccount(storage)) await markChanged(sync, 'sessions', session.id)
    return true
  }
  const [copied] = await Promise.all([merge().catch((error: unknown) => {
    abortTransaction(tx)
    throw error
  }), tx.done])
  return copied
}

/** 本地存储失败不打断对话，只在控制台留痕 */
export const reportStorageError = (action: string) => (error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`[storage] ${action} failed`, error)
}
