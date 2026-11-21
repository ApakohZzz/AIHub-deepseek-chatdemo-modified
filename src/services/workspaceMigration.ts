import {
  countStoredSessions,
  loadFile,
  mergeStoredSession,
  readStoredSessions,
  type StoredFile,
} from './chat/db.js'
import type { Session } from './chat/types.js'

const hash = async (value: BufferSource) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', value)), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')

export const countMergeSources = async (sources: readonly (string | null)[]) => {
  const counts = await Promise.all(sources.map(countStoredSessions))
  return counts.reduce((total, count) => total + count, 0)
}

export const mergeWorkspaceHistory = async (
  from: string | null,
  storage: string,
  copyTitle: (title: string) => string
) => {
  const movedFiles = new Map<string, string>()
  const text = new TextEncoder()
  const account = storage.replace(/^local:/, '')
  let copied = 0
  for await (const source of readStoredSessions(from)) {
    const files: StoredFile[] = []
    const messages = []
    for (const message of source.messages) {
      if (message.role === 'assistant') {
        messages.push(message)
        continue
      }
      const attachments = []
      for (const attachment of message.files) {
        let id = movedFiles.get(attachment.id)
        if (!id) {
          const blob = await loadFile(attachment.id, from)
          if (blob) {
            const identity = await hash(await blob.arrayBuffer())
            id =
              'import-file-' +
              (await hash(text.encode(JSON.stringify([account, blob.type, identity]))))
            movedFiles.set(attachment.id, id)
            files.push({ id, blob })
          }
        }
        attachments.push(id ? { ...attachment, id } : attachment)
      }
      messages.push({ ...message, files: attachments })
    }
    const original: Session = { ...source, messages }
    const copy = {
      ...original,
      id: 'import-chat-' + (await hash(text.encode(JSON.stringify(original)))),
      title: copyTitle(original.title),
    }
    if (await mergeStoredSession(storage, original, copy, files)) copied++
  }
  return copied
}
