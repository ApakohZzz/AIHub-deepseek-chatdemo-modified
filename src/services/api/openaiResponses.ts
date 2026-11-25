import { throwIfAborted } from '../../utils/abort.js'
import { readServerSentEvents } from './sse.js'
import { ApiError } from './transport.js'
import type { MessageStreamEvent, MessageUsage, TextCitation } from './types.js'

type Usage = {
  input_tokens?: number
  input_tokens_details?: { cached_tokens?: number }
  output_tokens?: number
}

type ResponseEvent = {
  type: string
  item_id?: string
  content_index?: number
  delta?: string
  annotation?: { type: string; url?: string; title?: string }
  message?: string
  response?: {
    error?: { message?: string } | null
    incomplete_details?: { reason?: string } | null
    usage?: Usage | null
  }
}

const normalizeUsage = (usage: Usage | null | undefined): MessageUsage | undefined => {
  if (!usage) {
    return undefined
  }
  const cached = usage.input_tokens_details?.cached_tokens ?? 0
  return {
    input_tokens: Math.max(0, (usage.input_tokens ?? 0) - cached),
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
    output_tokens: usage.output_tokens ?? 0,
  }
}

const toCitation = (annotation: ResponseEvent['annotation']): TextCitation | undefined => {
  if (annotation?.type !== 'url_citation' || typeof annotation.url !== 'string') {
    return undefined
  }
  const url = URL.canParse(annotation.url) ? new URL(annotation.url) : undefined
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    return undefined
  }
  return {
    type: 'web_search_result_location',
    url: url.href,
    title: typeof annotation.title === 'string' ? annotation.title : null,
    cited_text: '',
    encrypted_index: '',
  }
}

export async function* streamOpenAIResponses(
  response: Response,
  model: string,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
    throw new ApiError('protocol', '供应商未返回 SSE 响应。')
  }
  yield { type: 'message_start', message: { id: crypto.randomUUID(), model } }
  const blocks = new Map<string, number>()
  for await (const { data } of readServerSentEvents(response.body, signal)) {
    throwIfAborted(signal)
    if (data === '[DONE]') {
      break
    }
    let event: ResponseEvent
    try {
      event = JSON.parse(data) as ResponseEvent
    } catch {
      throw new ApiError('protocol', '供应商返回了无效的流式数据。')
    }
    if (!event || typeof event.type !== 'string') {
      throw new ApiError('protocol', '供应商返回了无效的流式数据。')
    }
    if (event.type === 'error' || event.type === 'response.failed') {
      throw new ApiError(
        'stream',
        event.message ?? event.response?.error?.message ?? '供应商返回错误。'
      )
    }
    if (event.type === 'response.completed' || event.type === 'response.incomplete') {
      const incomplete = event.type === 'response.incomplete'
      if (incomplete && event.response?.incomplete_details?.reason !== 'max_output_tokens') {
        throw new ApiError('stream', '供应商中止了本次回答。')
      }
      for (const index of blocks.values()) {
        yield { type: 'content_block_stop', index }
      }
      yield {
        type: 'message_delta',
        delta: { stop_reason: incomplete ? 'max_tokens' : 'end_turn', stop_sequence: null },
        usage: normalizeUsage(event.response?.usage),
      }
      yield { type: 'message_stop' }
      return
    }
    const citation =
      event.type === 'response.output_text.annotation.added'
        ? toCitation(event.annotation)
        : undefined
    const text =
      event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta'
        ? event.delta
        : undefined
    if (!citation && (typeof text !== 'string' || !text)) {
      continue
    }
    const key = `${event.item_id ?? ''}:${event.content_index ?? 0}`
    let index = blocks.get(key)
    if (index === undefined) {
      index = blocks.size
      blocks.set(key, index)
      yield { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }
    }
    yield {
      type: 'content_block_delta',
      index,
      delta: citation
        ? { type: 'citations_delta', citation }
        : { type: 'text_delta', text: text ?? '' },
    }
  }
  throwIfAborted(signal)
  throw new ApiError('interrupted', '')
}
