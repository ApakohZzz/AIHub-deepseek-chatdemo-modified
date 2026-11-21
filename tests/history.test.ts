import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Session } from '../src/services/chat/types.js'

Object.assign(globalThis, { __API_ORIGIN__: 'https://api.deepseek.com' })
const { toIndexEntry, toSessionFile } = await import('../src/services/chat/history/toArchive.js')
const { readSessionFile, readSessionIndex } = await import('../src/services/chat/history/schema.js')
const { toLocalSession } = await import('../src/services/chat/history/toLocal.js')

test('round-trips provider and model metadata while retaining DeepSeek v3 compatibility', () => {
  const now = Date.now()
  const connection = { providerId: 'fixture-provider', model: 'fixture-model' }
  const session: Session = {
    id: 'fixture-session',
    title: 'History',
    createdAt: now,
    updatedAt: now,
    connection,
    messages: [
      { id: 'u1', role: 'user', content: 'Hello', files: [], createdAt: now },
      {
        id: 'a1',
        role: 'assistant',
        createdAt: now,
        model: connection.model,
        providerId: connection.providerId,
        prefix: true,
        status: 'done',
        blocks: [{ type: 'text', text: 'Hello!' }],
      },
    ],
  }
  const exported = toSessionFile(session, () => null)
  const imported = toLocalSession(readSessionFile(JSON.parse(JSON.stringify(exported)))).session
  assert.deepEqual(imported.connection, connection)
  assert.equal(
    imported.messages[1].role === 'assistant' && imported.messages[1].providerId,
    connection.providerId
  )
  assert.equal(
    imported.messages[1].role === 'assistant' && imported.messages[1].model,
    connection.model
  )
  const legacy = structuredClone(exported)
  delete legacy.ai_hub
  for (const message of legacy.messages) delete message.ai_hub
  const old = toLocalSession(readSessionFile(legacy)).session
  assert.equal(old.connection, undefined)
  assert.equal(old.messages.length, 2)
  assert.equal(old.messages[1].role === 'assistant' && old.messages[1].model, null)
  assert.equal(JSON.stringify(exported).includes('apiKey'), false)
})

test('preserves pins through a v3 archive and accepts legacy entries without a pin', () => {
  const now = Date.now()
  const file = toSessionFile(
    {
      id: 'pinned-fixture',
      title: 'Keep this chat',
      pinned: true,
      createdAt: now,
      updatedAt: now,
      messages: [],
    },
    () => null
  )
  const index = toIndexEntry(file)
  assert.equal(readSessionIndex([index])[0].pinned, true)
  assert.equal(toLocalSession(readSessionFile(file)).session.pinned, true)
  assert.equal(
    toLocalSession(readSessionFile({ ...file, pinned: undefined })).session.pinned,
    false
  )
})

test('keeps document originals in a v3 archive and accepts older metadata-only attachments', () => {
  const now = Date.now()
  const path = 'chat_sessions/files-fixture_files/text-file_note.txt'
  const file = toSessionFile({
    id: 'files-fixture', title: 'Attachment', createdAt: now, updatedAt: now,
    messages: [{
      id: 'message', role: 'user', createdAt: now, content: 'Read this',
      files: [{ id: 'text-file', name: 'note.txt', serverId: null, size: 7, mimeType: 'text/plain', isImage: false }],
    }],
  }, () => path)
  const restored = toLocalSession(readSessionFile(file))
  assert.deepEqual(restored.attachments.get(path), { id: 'text-file', type: 'text/plain' })
  const message = restored.session.messages[0]
  assert.equal(message.role, 'user')
  assert.equal(message.files[0].mimeType, 'text/plain')
  assert.equal(message.files[0].isImage, false)

  const files = file.messages[0].fragments.find((fragment) => fragment.type === 'FILE')?.files
  assert.ok(files)
  files[0].export_path = null
  delete files[0].ai_hub_mime_type
  assert.equal(toLocalSession(readSessionFile(file)).attachments.size, 0)
})
