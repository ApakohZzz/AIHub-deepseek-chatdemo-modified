import * as db from '../db.js'
import type { Session } from '../types.js'
import { EXPORT_FORMAT_VERSION, type Manifest, type SessionIndexEntry } from './format.js'
import { INDEX_PATH, MANIFEST_PATH, attachmentPath, sessionPath } from './paths.js'
import { toIndexEntry, toSessionFile } from './toArchive.js'
import { writeArchive } from './zipWriter.js'

const json = (value: unknown) => new Blob([JSON.stringify(value)], { type: 'application/json' })

/**
 * 导出会话索引、消息和可用的附件原件。每个会话目录各写一份原件。
 */
export const exportArchive = async (
  sessions: Iterable<Session> | AsyncIterable<Session>
): Promise<Blob> => {
  const manifest: Manifest = { export_format_version: EXPORT_FORMAT_VERSION }
  const entries = [{ name: MANIFEST_PATH, blob: json(manifest) }]
  const attachmentEntries: { name: string; blob: Blob }[] = []
  const index: SessionIndexEntry[] = []
  const originals = new Map<string, Blob | undefined>()
  for await (const session of sessions) {
    for (const message of session.messages) {
      if (message.role === 'user') {
        for (const file of message.files) {
          if (!originals.has(file.id)) {
            originals.set(file.id, await db.loadFile(file.id))
          }
        }
      }
    }
    const attachments = new Map<string, Blob>()
    const data = toSessionFile(session, ({ id, name }) => {
      const blob = originals.get(id)
      if (!blob) {
        return null
      }
      const path = attachmentPath(session.id, id, name)
      attachments.set(path, blob)
      return path
    })
    entries.push({ name: sessionPath(session.id), blob: json(data) })
    for (const [name, blob] of attachments) {
      attachmentEntries.push({ name, blob })
    }
    index.push(toIndexEntry(data))
  }
  entries.push({ name: INDEX_PATH, blob: json(index) })
  return writeArchive(entries.concat(attachmentEntries))
}
