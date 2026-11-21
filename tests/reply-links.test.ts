import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildReplyView } from '../src/services/chat/view.js'
import type { TextCitation } from '../src/services/api/types.js'

const reference = (url: string): TextCitation => ({
  type: 'web_search_result_location',
  url,
  title: 'Reference',
  cited_text: '',
  encrypted_index: '',
})

test('shows only HTTP(S) citations without embedded credentials, including restored replies', () => {
  const view = buildReplyView({
    id: 'fixture-reply', role: 'assistant', status: 'done', prefix: false,
    createdAt: 1, model: null,
    blocks: [{ type: 'text', text: 'References', citations: [
      reference('file:///local-notes.txt'),
      reference('https://demo:example@example.test/private'),
      reference('https://example.test/source'),
    ] }],
  }, false)
  assert.deepEqual(view.sources.map(({ url }) => url), ['https://example.test/source'])
  assert.equal(view.answer?.markdown, 'References[citation:1]')
})
