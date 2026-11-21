import assert from 'node:assert/strict'
import { afterEach, mock, test } from 'node:test'
import type { CreateMessageRequest } from '../src/services/api/types.js'
import type { ProviderProfile } from '../src/services/providers.js'

Object.assign(globalThis, { __API_ORIGIN__: 'https://api.deepseek.com' })
const { streamMessage, ApiError } = await import('../src/services/api/client.js')
const { imageDataUrl } = await import('../src/services/api/openai.js')
afterEach(() => mock.restoreAll())

test('encodes a Windows image with an empty MIME as an image URL', async () => {
  const png = new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])])
  assert.equal(png.type, '')
  assert.match(await imageDataUrl(png), /^data:image\/png;base64,/)
})

const profile: ProviderProfile = {
  id: 'fixture',
  name: 'Fixture',
  protocol: 'openai',
  baseUrl: 'https://example.com/v1',
  apiKey: 'fixture-credential',
  scope: 'fixture-scope',
  models: ['fixture-model'],
}
const request: CreateMessageRequest = {
  model: 'fixture-model',
  system: 'AI Hub',
  messages: [
    { role: 'latest_reminder', content: 'metadata' },
    { role: 'user', content: '你好' },
  ],
  thinking: { type: 'disabled' },
  tools: [],
  safety_check: { level: 'high' },
}
const response = (chunks: unknown[], done = true) => {
  const wire =
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\r\n\r\n`).join('') +
    (done ? 'data: [DONE]\r\n\r\n' : '')
  const bytes = new TextEncoder().encode(wire)
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7))
        controller.close()
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } }
  )
}

test('sends an output cap only for the configured model using the protocol field', async () => {
  for (const protocol of ['openai', 'deepseek'] as const) {
    const configured = {
      ...profile, protocol, modelParameters: { 'fixture-model': { contextWindow: 4096, maxOutputTokens: 1024 } },
    }
    const bodies: Record<string, unknown>[] = []
    const fetch = mock.method(globalThis, 'fetch', async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      return protocol === 'openai'
        ? response([{ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }])
        : response([{ type: 'message_start', message: { id: 'fixture', model: request.model } }, { type: 'message_stop' }], false)
    })
    for (const model of [request.model, 'another-model']) {
      await Array.fromAsync(streamMessage(configured.apiKey, { ...request, model }, new AbortController().signal, configured))
    }
    const limitField = protocol === 'openai' ? 'max_completion_tokens' : 'max_tokens'
    assert.equal(bodies[0][limitField], 1024)
    assert.equal(Object.hasOwn(bodies[1], limitField), false)
    assert.equal(Object.hasOwn(bodies[0], 'contextWindow'), false)
    fetch.mock.restore()
  }
})

test('routes OpenAI web search through Responses and preserves output, citations, and usage', async () => {
  const model = 'gpt-6.1-sol'
  const configured = {
    ...profile, baseUrl: 'https://api.openai.com/v1', models: [model],
    modelParameters: { [model]: { maxOutputTokens: 4096 } },
  }
  mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, configured.baseUrl + '/responses')
    assert.deepEqual(JSON.parse(String(init?.body)), {
      model, input: [{ role: 'system', content: 'AI Hub' }, { role: 'user', content: '你好' }],
      stream: true, store: false, tools: [{ type: 'web_search' }], reasoning: { effort: 'low' }, max_output_tokens: 4096,
    })
    return response([
      { type: 'response.web_search_call.searching' },
      { type: 'response.output_text.delta', item_id: 'answer', delta: '你好' },
      { type: 'response.output_text.annotation.added', item_id: 'answer', annotation: { type: 'url_citation', url: 'https://example.com/source', title: 'Source' } },
      { type: 'response.output_text.annotation.added', item_id: 'answer', annotation: { type: 'url_citation', url: 'javascript:void(0)' } },
      { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' }, usage: {
        input_tokens: 20, input_tokens_details: { cached_tokens: 5 }, output_tokens: 30,
      } } },
    ], false)
  })
  const events = await Array.fromAsync(streamMessage(
    configured.apiKey, { ...request, model }, new AbortController().signal, configured, true
  ))
  const citations = events.flatMap((event) => event.type === 'content_block_delta' && event.delta.type === 'citations_delta' ? [event.delta.citation.url] : [])
  assert.deepEqual(citations, ['https://example.com/source'])
  assert.deepEqual(events.at(-2), {
    type: 'message_delta', delta: { stop_reason: 'max_tokens', stop_sequence: null },
    usage: { input_tokens: 15, cache_read_input_tokens: 5, cache_creation_input_tokens: 0, output_tokens: 30 },
  })
  assert.equal(events.at(-1)?.type, 'message_stop')
})

test('keeps unknown endpoints on Chat Completions and surfaces OpenAI search failures', async () => {
  const model = 'gpt-6.1-sol'
  const configured = { ...profile, models: [model] }
  const fetch = mock.method(globalThis, 'fetch', async (url, init) => {
    if (url === profile.baseUrl + '/chat/completions') {
      const body = JSON.parse(String(init?.body))
      assert.equal(Object.hasOwn(body, 'reasoning_effort'), false)
      assert.equal(Object.hasOwn(body, 'tools'), false)
      return response([{ choices: [{ delta: { content: 'Done' }, finish_reason: 'stop' }] }])
    }
    assert.equal(url, 'https://api.openai.com/v1/responses')
    return response([{ type: 'response.failed', response: { error: { message: 'Fixture error' } } }], false)
  })
  const generate = (current: ProviderProfile) => Array.fromAsync(streamMessage(
    current.apiKey, { ...request, model }, new AbortController().signal, current, true
  ))
  assert.equal((await generate(configured)).at(-1)?.type, 'message_stop')
  const official = { ...configured, baseUrl: 'https://api.openai.com/v1' }
  await assert.rejects(generate(official), (error) => error instanceof ApiError && error.message === 'Fixture error')
  await assert.rejects(generate({ ...official, modelParameters: { [model]: { maxOutputTokens: 15 } } }),
    (error) => error instanceof ApiError && error.localMessage?.key === 'openaiSearchOutputLimit')
  assert.equal(fetch.mock.callCount(), 2)
})

test('streams fragmented UTF-8 reasoning and Markdown through the existing reply event pipeline', async () => {
  mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://example.com/v1/chat/completions')
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-credential')
    const body = JSON.parse(String(init?.body))
    assert.deepEqual(
      body.messages.map((message: { role: string }) => message.role),
      ['system', 'user']
    )
    assert.equal(body.model, 'fixture-model')
    assert.equal(body.tools, undefined)
    return response([
      { choices: [{ delta: { reasoning_content: '先思考。' } }] },
      { choices: [{ delta: { content: '你好，**AI Hub**。' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      {
        choices: [],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 8,
          prompt_tokens_details: { cached_tokens: 3 },
        },
      },
    ])
  })
  const events = await Array.fromAsync(
    streamMessage(profile.apiKey, request, new AbortController().signal, profile)
  )
  assert.equal(events.at(-1)?.type, 'message_stop')
  assert(
    events.some(
      (event) =>
        event.type === 'content_block_delta' &&
        event.delta.type === 'thinking_delta' &&
        event.delta.thinking === '先思考。'
    )
  )
  assert(
    events.some(
      (event) =>
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta' &&
        event.delta.text === '你好，**AI Hub**。'
    )
  )
  const usage = events.find((event) => event.type === 'message_delta')
  assert.equal(usage?.type === 'message_delta' && usage.usage?.cache_read_input_tokens, 3)
})

test('accepts a completed stream without DONE, and reports a genuinely truncated stream', async () => {
  mock.method(globalThis, 'fetch', async () =>
    response([{ choices: [{ delta: { content: 'done' }, finish_reason: 'length' }] }], false)
  )
  const events = await Array.fromAsync(
    streamMessage(profile.apiKey, request, new AbortController().signal, profile)
  )
  assert(
    events.some(
      (event) => event.type === 'message_delta' && event.delta.stop_reason === 'max_tokens'
    )
  )
  mock.restoreAll()
  mock.method(globalThis, 'fetch', async () =>
    response([{ choices: [{ delta: { content: 'cut off' } }] }], false)
  )
  await assert.rejects(
    Array.fromAsync(streamMessage(profile.apiKey, request, new AbortController().signal, profile)),
    (error) => error instanceof ApiError && error.kind === 'interrupted'
  )
})

test('stopping generation aborts consumption instead of reporting success', async () => {
  const abort = new AbortController()
  mock.method(globalThis, 'fetch', async () =>
    response([{ choices: [{ delta: { content: 'hello' } }] }])
  )
  await assert.rejects(
    (async () => {
      for await (const event of streamMessage(profile.apiKey, request, abort.signal, profile))
        if (event.type === 'content_block_delta') abort.abort()
    })(),
    (error) => error instanceof DOMException && error.name === 'AbortError'
  )
})

test('keeps DeepSeek on its own endpoint and credentials', async () => {
  const deepseek = {
    ...profile,
    protocol: 'deepseek' as const,
    baseUrl: 'https://deepseek.example.com',
    apiKey: 'deepseek-fixture-credential',
  }
  mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://deepseek.example.com/anthropic/v1/messages')
    assert.equal(new Headers(init?.headers).get('x-api-key'), 'deepseek-fixture-credential')
    return response(
      [
        { type: 'message_start', message: { id: 'fixture', model: 'fixture-model' } },
        { type: 'message_stop' },
      ],
      false
    )
  })
  const events = await Array.fromAsync(
    streamMessage(deepseek.apiKey, request, new AbortController().signal, deepseek)
  )
  assert.equal(events.at(-1)?.type, 'message_stop')
})
