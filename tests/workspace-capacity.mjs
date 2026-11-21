import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { DatabaseSync } from 'node:sqlite'
import { openWorkspace } from '../server/workspace.mjs'

const directory = await mkdtemp(join(tmpdir(), 'ai-hub-workspace-capacity-'))
const db = new DatabaseSync(join(directory, 'fixture.sqlite'))
try {
  db.exec('PRAGMA journal_mode = WAL')
  const workspace = openWorkspace(db, { key: randomBytes(32), dataDir: directory })
  const path = '/sync/files/' + Buffer.from('capacity-fixture').toString('base64url')
  const owner = 'capacity-fixture'
  const chunk = Buffer.alloc(1024 * 1024, 173)
  const limit = 64 * chunk.length
  const prefix = Buffer.from([0, 0])
  const sha = createHash('sha256').update(prefix)
  for (let index = 0; index < 64; index++) sha.update(chunk)
  const expected = sha.digest('hex')

  const mockResponse = () => {
    const response = new EventEmitter()
    response.writeHead = (status, headers) => Object.assign(response, { status, headers })
    const stored = createHash('sha256')
    response.write = (chunk, done) => {
      stored.update(chunk)
      done()
    }
    response.end = () => {
      response.digest = stored.digest('hex')
      response.emit('close')
    }
    return response
  }
  const json = (response, status, value) => {
    Object.assign(response, { status, value })
    response.emit('close')
  }
  const fail = (response, status, error) => json(response, status, { error })
  const upload = Readable.from(
    (function* () {
      yield prefix
      for (let index = 0; index < 64; index++) yield chunk
    })()
  )
  upload.method = 'PUT'
  upload.headers = {
    'content-type': 'application/octet-stream',
    'content-length': String(limit + prefix.length),
    'x-aihub-revision': '0',
    'x-aihub-mutation': randomUUID(),
  }
  const written = mockResponse()
  await workspace.route(upload, written, owner, path, new URLSearchParams(), json, fail)
  assert.equal(written.status, 200)
  assert.deepEqual(written.value, { revision: 1 })

  const downloaded = mockResponse()
  await workspace.route(
    { method: 'GET' },
    downloaded,
    owner,
    path,
    new URLSearchParams(),
    json,
    fail
  )
  assert.equal(downloaded.status, 200)
  assert.equal(downloaded.headers['Content-Length'], limit + prefix.length)
  assert.equal(downloaded.digest, expected)
  console.log(
    `Attachment ${limit} bytes, SHA-256 ${downloaded.digest}, peak RSS ${process.resourceUsage().maxRSS} KiB`
  )
} finally {
  db.close()
  await rm(directory, { recursive: true, force: true })
}
