import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'
import { statfsSync } from 'node:fs'

const recordPath = /^\/sync\/(sessions|files|settings|drafts)\/([A-Za-z0-9_-]{1,768})$/
const mutationId = /^[a-f0-9-]{36}$/i
const mib = 1024 * 1024
const gib = 1024 * mib
const chunkSize = 4 * mib
const overhead = 28
const partCount = (size) => Math.max(1, Math.ceil(size / chunkSize))
const storedSize = (size) => (size == null ? 0 : size + partCount(size) * overhead)
const pageSize = 100
const mutationHistory = 4096
const detachedFileGrace = 24 * 60 * 60 * 1000
const unusedFileGrace = 7 * detachedFileGrace
const sessionMediaType = 'application/x-aihub-session'

const readNumber = (value) => {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null
  const number = Number(value)
  return Number.isSafeInteger(number) ? number : null
}

const assetIds = (files) => {
  const ids = new Set()
  for (const value of files) {
    if (typeof value !== 'string') continue
    const id = Buffer.from(value).toString('base64url')
    if (id && id.length <= 768) ids.add(id)
  }
  return ids
}

const readPayload = async (req, kind) => {
  const file = kind === 'files'
  const type = req.headers['content-type']?.split(';')[0].toLowerCase()
  const sessionEnvelope = kind === 'sessions' && type === sessionMediaType
  if (!sessionEnvelope && type !== (file ? 'application/octet-stream' : 'application/json'))
    return { status: 415, error: 'workspace_media_type' }
  const limit = sessionEnvelope ? 65 * mib + 4 : file ? 64 * mib + 257 : mib
  const declared = readNumber(req.headers['content-length'])
  if (declared > limit) return { status: 413, error: 'workspace_record_too_large' }
  const fixedBuffer = declared === null ? null : Buffer.allocUnsafe(declared)
  const chunks = []
  let size = 0
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const previous = size
    size += chunk.length
    if (size > limit) return { status: 413, error: 'workspace_record_too_large' }
    if (fixedBuffer) {
      if (size > fixedBuffer.length) return { status: 400, error: 'workspace_invalid_record' }
      chunk.copy(fixedBuffer, previous)
    } else chunks.push(chunk)
  }
  if (fixedBuffer && size !== fixedBuffer.length)
    return { status: 400, error: 'workspace_invalid_record' }
  let payload = fixedBuffer ?? Buffer.concat(chunks, size)
  let references
  if (!file) {
    try {
      const json = (bytes) => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      if (sessionEnvelope) {
        // Parse only the bounded attachment manifest. Session JSON can include years of messages.
        const length = payload.readUInt32BE(0)
        if (length > mib || length > payload.length - 6) throw new Error()
        const metadata = json(payload.subarray(4, 4 + length))
        if (!Array.isArray(metadata) || metadata.some((id) => typeof id !== 'string'))
          throw new Error()
        references = assetIds(metadata)
        payload = payload.subarray(4 + length)
        if (payload.length > 64 * mib) return { status: 413, error: 'workspace_record_too_large' }
        if (payload[0] !== 0x7b || payload.at(-1) !== 0x7d) throw new Error()
      } else {
        const value = json(payload)
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
        const files =
          kind === 'sessions' && Array.isArray(value.messages)
            ? value.messages.flatMap((message) =>
                message?.role === 'user' && Array.isArray(message.files) ? message.files : []
              )
            : kind === 'drafts' && Array.isArray(value.attachments)
              ? value.attachments
              : []
        references = assetIds(files.map((file) => file?.id))
      }
    } catch {
      return { status: 400, error: 'workspace_invalid_record' }
    }
  }
  return { payload, references }
}

export const openWorkspace = (db, { key: vaultKey, dataDir }) => {
  const key = createHmac('sha256', vaultKey).update('ai-hub:workspace:payload:v1').digest()
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_heads (
      owner TEXT PRIMARY KEY, revision INTEGER NOT NULL, bytes INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS workspace_records (
      owner TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
      revision INTEGER NOT NULL, size INTEGER,
      PRIMARY KEY (owner, kind, id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS workspace_changes ON workspace_records(owner, revision);
    CREATE TABLE IF NOT EXISTS workspace_chunks (
      owner TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
      part INTEGER NOT NULL, payload BLOB NOT NULL,
      PRIMARY KEY (owner, kind, id, part)
    );
    CREATE TABLE IF NOT EXISTS workspace_mutations (
      owner TEXT NOT NULL, mutation TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      PRIMARY KEY (owner, mutation)
    );
    CREATE INDEX IF NOT EXISTS workspace_mutation_revisions ON workspace_mutations(owner, revision);
    CREATE TABLE IF NOT EXISTS workspace_file_refs (
      owner TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, file_id TEXT NOT NULL,
      PRIMARY KEY (owner, kind, id, file_id)
    );
    CREATE INDEX IF NOT EXISTS workspace_file_ref_count ON workspace_file_refs(owner, file_id);
    CREATE TABLE IF NOT EXISTS workspace_file_gc (
      owner TEXT NOT NULL, file_id TEXT NOT NULL, eligible_after INTEGER NOT NULL,
      PRIMARY KEY (owner, file_id)
    );
    CREATE INDEX IF NOT EXISTS workspace_file_gc_due ON workspace_file_gc(eligible_after);
  `)
  const head = db.prepare(`
    INSERT INTO workspace_heads (owner, revision, bytes) VALUES (?, 1, ?)
    ON CONFLICT (owner) DO UPDATE SET revision = revision + 1, bytes = bytes + excluded.bytes
    RETURNING revision
  `)
  const accountUsage = db.prepare('SELECT bytes FROM workspace_heads WHERE owner = ?')
  const totalUsage = db.prepare('SELECT COALESCE(SUM(bytes), 0) AS bytes FROM workspace_heads')
  const revisionFor = db.prepare(`
    SELECT revision, size, size IS NULL AS deleted FROM workspace_records
    WHERE owner = ? AND kind = ? AND id = ?
  `)
  const put = db.prepare(`
    INSERT INTO workspace_records (owner, kind, id, revision, size) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (owner, kind, id) DO UPDATE SET revision = excluded.revision, size = excluded.size
  `)
  const readChunk = db.prepare(
    'SELECT payload FROM workspace_chunks WHERE owner = ? AND kind = ? AND id = ? AND part = ?'
  )
  const appendChunk = db.prepare('INSERT INTO workspace_chunks VALUES (?, ?, ?, ?, ?)')
  const deleteChunks = db.prepare(
    'DELETE FROM workspace_chunks WHERE owner = ? AND kind = ? AND id = ?'
  )
  const list = db.prepare(`
    SELECT kind, id, revision, size IS NULL AS deleted FROM workspace_records
    WHERE owner = ? AND revision > ? ORDER BY revision LIMIT ?
  `)
  const receipt = db.prepare(`
    SELECT kind, id, revision FROM workspace_mutations WHERE owner = ? AND mutation = ?
  `)
  const remember = db.prepare(`
    INSERT INTO workspace_mutations (owner, mutation, kind, id, revision) VALUES (?, ?, ?, ?, ?)
  `)
  const expireReceipts = db.prepare(
    'DELETE FROM workspace_mutations WHERE owner = ? AND revision <= ?'
  )
  const existingReferences = db.prepare(
    'SELECT file_id FROM workspace_file_refs WHERE owner = ? AND kind = ? AND id = ?'
  )
  const addReference = db.prepare('INSERT INTO workspace_file_refs VALUES (?, ?, ?, ?)')
  const removeReference = db.prepare(
    'DELETE FROM workspace_file_refs WHERE owner = ? AND kind = ? AND id = ? AND file_id = ?'
  )
  const referenceExists = db.prepare(
    'SELECT 1 FROM workspace_file_refs WHERE owner = ? AND file_id = ? LIMIT 1'
  )
  const scheduleCleanup = db.prepare(`
    INSERT INTO workspace_file_gc VALUES (?, ?, ?)
    ON CONFLICT (owner, file_id) DO UPDATE SET eligible_after = excluded.eligible_after
  `)
  const cancelCleanup = db.prepare('DELETE FROM workspace_file_gc WHERE owner = ? AND file_id = ?')
  const dueCleanup = db.prepare(
    'SELECT owner, file_id FROM workspace_file_gc WHERE eligible_after <= ? LIMIT 50'
  )
  const updateReferences = (owner, kind, id, references) => {
    if (kind === 'files') {
      if (!referenceExists.get(owner, id))
        scheduleCleanup.run(owner, id, Date.now() + unusedFileGrace)
      return
    }
    if (kind !== 'sessions' && kind !== 'drafts') return
    const previous = new Set(existingReferences.all(owner, kind, id).map(({ file_id }) => file_id))
    for (const fileId of references ?? []) {
      if (!previous.delete(fileId)) addReference.run(owner, kind, id, fileId)
      cancelCleanup.run(owner, fileId)
    }
    for (const fileId of previous) {
      removeReference.run(owner, kind, id, fileId)
      if (!referenceExists.get(owner, fileId))
        scheduleCleanup.run(owner, fileId, Date.now() + detachedFileGrace)
    }
  }

  let nextCleanup = 0
  const collectDetachedFiles = () => {
    const now = Date.now()
    if (now < nextCleanup) return
    nextCleanup = now + 60000
    const due = dueCleanup.all(now)
    if (!due.length) return
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const { owner, file_id: id } of due) {
        if (!referenceExists.get(owner, id)) {
          const current = revisionFor.get(owner, 'files', id)
          if (current && !current.deleted) {
            const { revision } = head.get(owner, -storedSize(current.size))
            deleteChunks.run(owner, 'files', id)
            put.run(owner, 'files', id, revision, null)
          }
        }
        cancelCleanup.run(owner, id)
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  const associatedData = (owner, kind, id, revision, index) =>
    Buffer.from(JSON.stringify([owner, kind, id, revision, index]))
  const encrypt = (data, aad) => {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(aad)
    const body = cipher.update(data)
    const final = cipher.final()
    return Buffer.concat([iv, cipher.getAuthTag(), body, final])
  }
  const decrypt = (data, aad) => {
    const packed = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    const decipher = createDecipheriv('aes-256-gcm', key, packed.subarray(0, 12))
    decipher.setAAD(aad)
    decipher.setAuthTag(packed.subarray(12, 28))
    const body = decipher.update(packed.subarray(28))
    const final = decipher.final()
    return final.length ? Buffer.concat([body, final]) : body
  }

  const save = (owner, kind, id, expected, mutation, { payload, references }) => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const previous = receipt.get(owner, mutation)
      const current = revisionFor.get(owner, kind, id)
      let result
      if (previous) {
        result =
          previous.id === id && previous.kind === kind
            ? { revision: previous.revision }
            : { invalidMutation: true }
      } else if (expected !== (current?.revision ?? 0)) {
        result = {
          conflict: true,
          revision: current?.revision ?? 0,
          deleted: current?.deleted === 1,
        }
      } else {
        const size = payload === null ? null : payload.length
        const bytes = storedSize(size)
        const delta = bytes - storedSize(current?.size)
        if (delta > 0) {
          const available = statfsSync(dataDir)
          if (
            (accountUsage.get(owner)?.bytes ?? 0) + delta > 4 * gib ||
            totalUsage.get().bytes + delta > 8 * gib ||
            available.bavail * available.bsize < 2 * gib + 2 * bytes
          ) {
            db.exec('ROLLBACK')
            return { noSpace: true }
          }
        }
        const { revision } = head.get(owner, delta)
        deleteChunks.run(owner, kind, id)
        if (payload !== null) {
          for (let part = 0; part < partCount(size); part++) {
            const aad = associatedData(owner, kind, id, revision, part)
            const chunk = payload.subarray(part * chunkSize, (part + 1) * chunkSize)
            appendChunk.run(owner, kind, id, part, encrypt(chunk, aad))
          }
        }
        put.run(owner, kind, id, revision, size)
        updateReferences(owner, kind, id, references)
        remember.run(owner, mutation, kind, id, revision)
        if (revision > mutationHistory) expireReceipts.run(owner, revision - mutationHistory)
        result = { revision }
      }
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  // Limit simultaneous buffered transfers, including downloads with slow receivers.
  let transfers = 0
  return {
    identity: (owner) =>
      createHmac('sha256', vaultKey)
        .update('ai-hub:workspace:identity:' + owner)
        .digest('hex'),
    async route(req, res, owner, path, params, json, fail) {
      if (path === '/sync/changes' && req.method === 'GET') {
        const after = readNumber(params.get('after') ?? '0')
        if (after === null) return fail(res, 400, 'workspace_invalid_cursor')
        if (!transfers) collectDetachedFiles()
        const rows = list.all(owner, after, pageSize + 1)
        const changes = rows
          .slice(0, pageSize)
          .map((row) => ({ ...row, deleted: row.deleted === 1 }))
        return json(res, 200, {
          changes,
          cursor: changes.at(-1)?.revision ?? after,
          more: rows.length > pageSize,
        })
      }
      const match = recordPath.exec(path)
      if (!match) return fail(res, 404, 'route_not_found')
      const [, kind, id] = match
      if (!['GET', 'PUT', 'DELETE'].includes(req.method))
        return fail(res, 405, 'method_not_allowed')
      if (kind === 'files' && req.method === 'DELETE') return fail(res, 405, 'method_not_allowed')
      if (transfers >= 1) return fail(res, 429, 'workspace_busy')
      transfers++
      const release = () => {
        transfers--
      }
      res.once('close', release)
      if (req.method === 'GET') {
        const row = revisionFor.get(owner, kind, id)
        if (row?.size == null) return fail(res, 404, 'workspace_record_not_found')
        res.writeHead(200, {
          'Content-Type':
            kind === 'files' ? 'application/octet-stream' : 'application/json; charset=utf-8',
          'Content-Length': row.size,
          'X-AIHub-Revision': row.revision,
        })
        for (let part = 0; part < partCount(row.size); part++) {
          if (res.destroyed) return
          const { payload } = readChunk.get(owner, kind, id, part)
          const chunk = decrypt(payload, associatedData(owner, kind, id, row.revision, part))
          await new Promise((resolve, reject) => {
            res.write(chunk, (error) => (error ? reject(error) : resolve()))
          })
        }
        return res.end()
      }
      const expected = readNumber(req.headers['x-aihub-revision'])
      const mutation = req.headers['x-aihub-mutation']
      if (expected === null || typeof mutation !== 'string' || !mutationId.test(mutation))
        return fail(res, 400, 'workspace_invalid_mutation')
      const input = req.method === 'PUT' ? await readPayload(req, kind) : { payload: null }
      if (input.error) return fail(res, input.status, input.error)
      const result = save(owner, kind, id, expected, mutation, input)
      if (result.invalidMutation) return fail(res, 400, 'workspace_invalid_mutation')
      if (result.noSpace) return fail(res, 507, 'workspace_storage_full')
      return json(res, result.conflict ? 409 : 200, result)
    },
  }
}
