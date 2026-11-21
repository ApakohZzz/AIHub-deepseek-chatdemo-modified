import assert from 'node:assert/strict'
import { test } from 'node:test'
import { speechLanguage, splitSpeechText } from '../src/services/speech/browserSpeech.js'

test('browser speech reads Markdown prose without URLs, citations, or fenced code', () => {
  assert.deepEqual(
    splitSpeechText(
      '# Title\n\n**可以**朗读 [这段话](https://example.com)[citation:1]。\n\n```sh\necho world\n```'
    ),
    ['Title 可以朗读 这段话。']
  )
  assert.deepEqual(splitSpeechText('```js\nconst code = 1\n```'), [])
})

test('long speech is split without breaking Unicode characters and keeps the answer language', () => {
  const text = '测试'.repeat(109) + 'a😀' + '测试'.repeat(200)
  const chunks = splitSpeechText(text)
  assert.equal(chunks.join(''), text)
  assert.ok(chunks.every((chunk) => chunk.length <= 220 && !/[\uD800-\uDBFF]$/.test(chunk)))
  assert.equal(speechLanguage('Hello', 'zh-CN'), 'en-US')
  assert.equal(speechLanguage('谢谢', 'en-US'), 'zh-CN')
  assert.equal(speechLanguage('いつもありがとうございます', 'zh-CN'), 'ja-JP')
})
