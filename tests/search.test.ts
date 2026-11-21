import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createChatSearchPattern, searchChatMessages } from '../src/services/chat/search.js'
import type { Session } from '../src/services/chat/types.js'

const keyword = createChatSearchPattern('  a+b   (出海) ')
assert.ok(keyword)
const fixture: Session = {
  id: 'search-fixture',
  title: 'Research',
  createdAt: 1,
  updatedAt: 4,
  rootMessageId: 'question',
  messages: [
    {
      id: 'question',
      role: 'user',
      content: '未匹配',
      files: [],
      createdAt: 1,
      selectedChildId: 'visible',
    },
    {
      id: 'hidden',
      role: 'user',
      content: 'A+B (出海)',
      files: [],
      createdAt: 2,
      parentId: 'question',
    },
    {
      id: 'visible',
      role: 'assistant',
      model: null,
      status: 'done',
      prefix: false,
      createdAt: 3,
      parentId: 'question',
      blocks: [
        { type: 'thinking', thinking: 'private scratch' },
        { type: 'text', text: 'placeholder only', isTemplate: true },
        { type: 'text', text: `${'Before. '.repeat(50)}A+B\n(出海) ${'After. '.repeat(50)}` },
      ],
    },
  ],
}

test('finds a literal, case insensitive phrase on the visible branch and clips its context', async () => {
  const read = async () => fixture
  const signal = new AbortController().signal
  const { hits } = await searchChatMessages([fixture.id], keyword, read, signal)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].messageId, 'visible')
  assert.match(hits[0].snippet, /^….*A\+B \(出海\).*…$/)
  assert.ok(hits[0].snippet.length < 128)
  assert.equal(
    (await searchChatMessages([fixture.id], /scratch|placeholder/, read, signal)).hits.length,
    0
  )
})

test('abandons results and further storage reads when a newer search cancels the request', async () => {
  const controller = new AbortController()
  const ids: string[] = []
  const read = async (id: string) => {
    ids.push(id)
    controller.abort()
    return fixture
  }
  await assert.rejects(
    searchChatMessages([fixture.id, 'later'], keyword, read, controller.signal),
    { name: 'AbortError' }
  )
  assert.deepEqual(ids, [fixture.id])
})

test('reports message hits before scanning later sessions and keeps them when a read fails', async () => {
  const batches: string[][] = []
  let beforeFailedRead: string[][] | undefined
  const read = async (id: string) => {
    if (id === 'unreadable') {
      beforeFailedRead = [...batches]
      throw new Error('Unable to read this session')
    }
    return { ...fixture, id }
  }
  const result = await searchChatMessages(
    [fixture.id, 'unreadable', 'later'],
    keyword,
    read,
    new AbortController().signal,
    ({ hits }) => batches.push(hits.map(({ sessionId }) => sessionId))
  )
  assert.deepEqual(beforeFailedRead, [[fixture.id]])
  assert.deepEqual(batches, [[fixture.id], [fixture.id, 'later']])
  assert.deepEqual(
    result.hits.map(({ sessionId }) => sessionId),
    [fixture.id, 'later']
  )
  assert.equal(result.failed, true)
})
