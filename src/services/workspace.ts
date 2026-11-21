import { create } from 'zustand'
import * as db from './chat/db.js'
import type {
  WorkspaceChange,
  WorkspaceKind,
  WorkspaceMutation,
  WorkspaceValue,
} from './chat/db.js'
import type { Session } from './chat/types.js'

const kinds = new Set<WorkspaceKind>(['sessions', 'files', 'settings', 'drafts'])
const pollInterval = 2500
const maxRetryDelay = 30000

type Status = 'local' | 'syncing' | 'synced' | 'offline' | 'error' | 'limit'
export const useWorkspaceSync = create(() => ({
  status: 'local' as Status,
  lastSync: null as number | null,
  fileEpoch: 0,
  hydrated: false,
}))

const modeKey = (workspace: string) => `ai-hub:storage-mode:${workspace}`
export const workspaceStorageMode = (workspace: string): 'account' | 'local' => {
  try {
    return localStorage.getItem(modeKey(workspace)) === 'local' ? 'local' : 'account'
  } catch {
    return 'account'
  }
}

export const selectWorkspaceStorage = (workspace: string, mode: 'account' | 'local') => {
  localStorage.setItem(modeKey(workspace), mode)
}

const localFlushes = new Set<() => Promise<void>>()
export const bindWorkspaceFlush = (flush: () => Promise<void>) => {
  localFlushes.add(flush)
  return () => {
    localFlushes.delete(flush)
  }
}

export const flushWorkspaceChanges = async () => {
  await Promise.all([...localFlushes].map((flush) => flush()))
}

const encodeId = (id: string) => {
  const bytes = new TextEncoder().encode(id)
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

const decodeId = (id: string) => {
  const bytes = Uint8Array.from(atob(id.replaceAll('-', '+').replaceAll('_', '/')), (char) =>
    char.charCodeAt(0)
  )
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

const recordPath = ({ kind, id }: { kind: WorkspaceKind; id: string }) => `/${kind}/${encodeId(id)}`

const packFile = (file: Blob) => {
  const type = new TextEncoder().encode(file.type)
  if (type.length > 255) throw new Error('Invalid attachment MIME type')
  return new Blob([Uint8Array.of(0, type.length), type, file], { type: 'application/octet-stream' })
}

const unpackFile = async (bytes: Blob) => {
  const prefix = new Uint8Array(await bytes.slice(0, 2).arrayBuffer())
  if (prefix.length !== 2 || prefix[0] !== 0 || prefix[1]! > bytes.size - 2)
    throw new Error('Invalid attachment envelope')
  const start = 2 + prefix[1]!
  const type = await bytes.slice(2, start).text()
  return bytes.slice(start, bytes.size, type)
}

const packSession = (session: WorkspaceValue, files: string[]) => {
  const metadata = new TextEncoder().encode(JSON.stringify([...new Set(files)]))
  const prefix = new ArrayBuffer(4)
  new DataView(prefix).setUint32(0, metadata.byteLength)
  return new Blob([prefix, metadata, JSON.stringify(session)], {
    type: 'application/x-aihub-session',
  })
}

const revisionNumber = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('Invalid workspace revision')
  return value
}

const sessionRecord = (value: object, id: string) => {
  const session = value as Partial<Session>
  if (
    session.id !== id ||
    typeof session.title !== 'string' ||
    !Array.isArray(session.messages) ||
    !Number.isFinite(session.createdAt) ||
    !Number.isFinite(session.updatedAt) ||
    session.messages.some(
      (message) =>
        !message ||
        typeof message.id !== 'string' ||
        (message.role === 'user'
          ? !Array.isArray(message.files)
          : message.role !== 'assistant' || !Array.isArray(message.blocks))
    )
  )
    throw new Error('Invalid workspace session')
  return session as Session
}

const equalValues = async (a: WorkspaceValue | null, b: WorkspaceValue | null) => {
  if (a instanceof Blob && b instanceof Blob) {
    if (a.size !== b.size || a.type !== b.type) return false
    for (let offset = 0; offset < a.size; offset += 1024 * 1024) {
      const size = 1024 * 1024
      const first = new Uint8Array(await a.slice(offset, offset + size).arrayBuffer())
      const second = new Uint8Array(await b.slice(offset, offset + size).arrayBuffer())
      if (first.some((byte, index) => byte !== second[index])) return false
    }
    return true
  }
  if (a instanceof Blob || b instanceof Blob) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

type SyncHooks = {
  onChange: (kinds: ReadonlySet<WorkspaceKind>) => Promise<void> | void
  conflictTitle: (title: string) => string
  canSync: () => boolean
  canSyncSession: (id: string) => boolean
}

const referencedFiles = (kind: WorkspaceKind, value: WorkspaceValue | null) => {
  if (kind === 'sessions' && value) {
    return (value as Session).messages.flatMap((message) =>
      message.role === 'user' ? message.files.map(({ id }) => id) : []
    )
  }
  if (kind === 'drafts' && value && 'attachments' in value && Array.isArray(value.attachments)) {
    return value.attachments.map(({ id }) => id)
  }
  return []
}

export const bindWorkspaceSync = (workspace: string, hooks: SyncHooks) => {
  const lifetime = new AbortController()
  const { signal } = lifetime
  const changes = new Set<WorkspaceKind>()
  let running = false
  let retryDelay = pollInterval
  let timer: ReturnType<typeof setTimeout> | undefined

  const request = (path: string, init?: RequestInit) => {
    signal.throwIfAborted()
    return fetch('/api/account/sync' + path, {
      ...init,
      headers: { 'X-AIHub-Workspace': workspace, ...init?.headers },
      cache: 'no-store',
      signal: AbortSignal.any([signal, AbortSignal.timeout(90000)]),
    })
  }

  const pullRecord = async (kind: WorkspaceKind, id: string) => {
    const response = await request(recordPath({ kind, id }))
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`Workspace read returned ${response.status}`)
    const revision = revisionNumber(Number(response.headers.get('X-AIHub-Revision')))
    if (!revision) throw new Error('Missing workspace revision')
    let value: WorkspaceValue
    if (kind === 'files') value = await unpackFile(await response.blob())
    else {
      const body: unknown = await response.json()
      if (!body || typeof body !== 'object' || Array.isArray(body))
        throw new Error('Invalid workspace record')
      value = kind === 'sessions' ? sessionRecord(body, id) : (body as Record<string, unknown>)
    }
    return { value, revision }
  }

  const pushRecord = async (pending: WorkspaceMutation, failedFiles: Set<string>) => {
    const record = await db.readWorkspaceMutation(workspace, pending)
    if (!record) return false
    const { value } = record
    const files = referencedFiles(pending.kind, value)
    if (files.some((id) => failedFiles.has(id))) return false
    if (pending.kind === 'sessions' && value) {
      const session = value as Session
      const unfinished = session.messages.some(
        (message) =>
          message.role === 'assistant' &&
          (message.status === 'pending' || message.status === 'streaming')
      )
      if (
        !hooks.canSyncSession(session.id) ||
        (unfinished && Date.now() - session.updatedAt < 120000)
      )
        return false
    }
    const blob =
      value instanceof Blob
        ? packFile(value)
        : value && pending.kind === 'sessions'
          ? packSession(value, files)
          : null
    const response = await request(recordPath(pending), {
      method: value === null ? 'DELETE' : 'PUT',
      headers: {
        'Content-Type': blob?.type ?? 'application/json',
        'X-AIHub-Revision': String(pending.baseRevision),
        'X-AIHub-Mutation': pending.mutation,
      },
      body: blob ?? (value === null ? undefined : JSON.stringify(value)),
    })
    if (response.status === 413 || response.status === 507) {
      if (pending.kind === 'files') failedFiles.add(pending.id)
      return true
    }
    if (!response.ok && response.status !== 409)
      throw new Error(`Workspace write returned ${response.status}`)
    const { revision, deleted } = await response.json()
    const recordedRevision = revisionNumber(revision)
    signal.throwIfAborted()
    if (response.ok) {
      await db.acknowledgeWorkspaceMutation(workspace, pending, recordedRevision)
      return false
    }
    const remote = deleted ? null : await pullRecord(pending.kind, pending.id)
    // The record was deleted after the conflict response. Re-read its tombstone on the next pass.
    if (!deleted && !remote) throw new Error('Workspace revision changed during conflict recovery')
    const remoteRevision = remote?.revision ?? recordedRevision
    const remoteValue = remote?.value ?? null
    if (await equalValues(value, remoteValue)) {
      await db.acknowledgeWorkspaceMutation(workspace, pending, remoteRevision)
      return false
    }
    if (
      await db.resolveWorkspaceConflict(
        workspace,
        pending,
        remoteRevision,
        remoteValue,
        value,
        hooks.conflictTitle
      )
    )
      changes.add(pending.kind)
    return false
  }

  const pullPage = async () => {
    const start = await db.readWorkspaceCursor(workspace)
    const response = await request(`/changes?after=${start}`)
    if (!response.ok) throw new Error(`Workspace changes returned ${response.status}`)
    const page = await response.json()
    const cursor = revisionNumber(page.cursor)
    if (!Array.isArray(page.changes) || cursor < start || typeof page.more !== 'boolean')
      throw new Error('Invalid workspace change page')
    let blocked = false
    for (const entry of page.changes) {
      if (
        !kinds.has(entry.kind) ||
        typeof entry.deleted !== 'boolean' ||
        typeof entry.id !== 'string'
      )
        throw new Error('Invalid workspace change')
      const change: WorkspaceChange = {
        kind: entry.kind,
        id: decodeId(entry.id),
        revision: revisionNumber(entry.revision),
        deleted: entry.deleted,
      }
      const state = await db.workspaceRecordState(workspace, change)
      if (state === 'known') continue
      if (state === 'pending') {
        blocked = true
        continue
      }
      const record = change.deleted ? null : await pullRecord(change.kind, change.id)
      if (!change.deleted && !record) {
        // A deletion replaces this row in the next feed read. Do not apply its outdated revision.
        blocked = true
        continue
      }
      if (record && record.revision >= change.revision) change.revision = record.revision
      signal.throwIfAborted()
      const result = await db.applyWorkspaceChange(workspace, change, record?.value ?? null)
      if (result === 'applied') changes.add(change.kind)
      if (result === 'pending') blocked = true
    }
    if (!blocked) await db.advanceWorkspaceCursor(workspace, cursor)
    return { more: page.more, blocked }
  }

  const synchronize = async () => {
    const pending = await db.listWorkspaceMutations(workspace)
    // A session or draft only becomes visible remotely after the originals it references are uploaded.
    const uploads = [
      ...pending.filter(({ kind }) => kind === 'files'),
      ...pending.filter(({ kind }) => kind !== 'files'),
    ]
    if (uploads.length) useWorkspaceSync.setState({ status: 'syncing' })
    const failedFiles = new Set<string>()
    let limit = false
    for (const change of uploads) {
      if (await pushRecord(change, failedFiles)) limit = true
    }
    let caughtUp = false
    for (let page = 0; page < 10; page++) {
      const { more, blocked } = await pullPage()
      if (blocked) break
      if (!more) {
        caughtUp = true
        break
      }
    }
    return { limit, caughtUp }
  }

  const refresh = async () => {
    if (running || signal.aborted) return
    clearTimeout(timer)
    running = true
    let completed: { limit: boolean; caughtUp: boolean } | undefined
    try {
      if (!hooks.canSync()) return
      completed = navigator.locks
        ? await navigator.locks.request(
            `ai-hub:sync:${workspace}`,
            { ifAvailable: true },
            async (lock) => {
              signal.throwIfAborted()
              if (lock) return synchronize()
              // Another tab may have pulled changes into this shared cache.
              for (const kind of kinds) changes.add(kind)
              return { limit: false, caughtUp: false }
            }
          )
        : await synchronize()
    } catch {
      if (!signal.aborted) {
        useWorkspaceSync.setState({ status: navigator.onLine ? 'error' : 'offline' })
        retryDelay = Math.min(retryDelay * 2, maxRetryDelay)
      }
    } finally {
      if (!signal.aborted) {
        try {
          if (changes.size) {
            if (changes.has('files'))
              useWorkspaceSync.setState(({ fileEpoch }) => ({ fileEpoch: fileEpoch + 1 }))
            await hooks.onChange(new Set(changes))
            changes.clear()
          }
          const result = completed
          if (result && !signal.aborted) {
            const pending = (await db.listWorkspaceMutations(workspace)).length
            useWorkspaceSync.setState(({ hydrated, lastSync }) => ({
              status: result.limit ? 'limit' : pending || !result.caughtUp ? 'syncing' : 'synced',
              hydrated: hydrated || result.caughtUp,
              lastSync: result.caughtUp ? Date.now() : lastSync,
            }))
            retryDelay = pollInterval
          }
        } catch {
          useWorkspaceSync.setState({ status: 'error' })
          retryDelay = Math.min(retryDelay * 2, maxRetryDelay)
        }
        if (!signal.aborted) timer = setTimeout(() => void refresh(), retryDelay)
      }
      running = false
    }
  }

  const wake = () => void refresh()
  window.addEventListener('online', wake, { signal })
  window.addEventListener('focus', wake, { signal })
  useWorkspaceSync.setState({ status: 'syncing', lastSync: null, hydrated: false })
  wake()
  return () => {
    lifetime.abort()
    clearTimeout(timer)
  }
}
