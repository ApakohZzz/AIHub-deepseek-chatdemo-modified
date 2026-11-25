import { throwIfAborted } from '../../utils/abort.js'
import { ApiError, request } from './transport.js'
import { streamOpenAIResponses } from './openaiResponses.js'
import { readServerSentEvents } from './sse.js'
import type { CreateMessageRequest, MessageStreamEvent, MessageUsage, StopReason } from './types.js'
import { providerApiBase, type ProviderProfile } from '../providers.js'
import { getModelOutputLimit } from '../modelCatalog.js'
import { getChatCapabilities } from '../chatCapabilities.js'

type Content =
  | string
  | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[]
type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: Content }
type Completion = {
  id?: string
  model?: string
  error?: { message?: string }
  choices?: {
    delta?: { content?: string; reasoning_content?: string; reasoning?: string; refusal?: string }
    message?: { content?: string }
    finish_reason?: string | null
  }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
}

export const imageDataUrl = async (blob: Blob): Promise<string> => {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let mime = blob.type
  if (!mime) {
    if (bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71)
      mime = 'image/png'
    else if (bytes[0] === 255 && bytes[1] === 216) mime = 'image/jpeg'
    else if (bytes[0] === 71 && bytes[1] === 73 && bytes[2] === 70) mime = 'image/gif'
    else if (String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') mime = 'image/webp'
  }
  if (!mime.startsWith('image/'))
    throw new ApiError('protocol', '无法识别图片格式，请重新添加 PNG、JPEG、GIF 或 WebP 图片。')
  let binary = ''
  for (let index = 0; index < bytes.length; index += 32768)
    binary += String.fromCharCode(...bytes.subarray(index, index + 32768))
  return `data:${mime};base64,${btoa(binary)}`
}

const fileContent = async (fileId: string, image: boolean): Promise<Exclude<Content, string>> => {
  if (!fileId.startsWith('local:')) throw new ApiError('protocol', '请重新选择附件后发送。')
  const { loadFile } = await import('../chat/db.js')
  const blob = await loadFile(fileId.slice(6))
  if (!blob) throw new ApiError('protocol', '本机没有附件原件，请重新添加文件。')
  if (!image) return [{ type: 'text', text: await blob.text() }]
  return [{ type: 'image_url', image_url: { url: await imageDataUrl(blob) } }]
}

const toMessages = async (body: CreateMessageRequest): Promise<ChatMessage[]> => {
  const result: ChatMessage[] = [{ role: 'system', content: body.system }]
  for (const message of body.messages) {
    if (message.role === 'latest_reminder') continue
    if (typeof message.content === 'string') {
      result.push({ role: message.role, content: message.content })
      continue
    }
    if (message.role === 'assistant') {
      const content = message.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('\n\n')
      if (content) result.push({ role: 'assistant', content })
      continue
    }
    const content: Exclude<Content, string> = []
    for (const block of message.content) {
      if (block.type === 'text') content.push(block)
      else content.push(...(await fileContent(block.source.file_id, block.type === 'image')))
    }
    result.push({ role: 'user', content })
  }
  if (result.at(-1)?.role === 'assistant')
    result.push({ role: 'user', content: '请接着上一个回答继续，避免重复已经输出的内容。' })
  return result
}

const normalizeUsage = (usage: Completion['usage']): MessageUsage => ({
  input_tokens: Math.max(
    0,
    (usage?.prompt_tokens ?? 0) - (usage?.prompt_tokens_details?.cached_tokens ?? 0)
  ),
  cache_read_input_tokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
  cache_creation_input_tokens: 0,
  output_tokens: usage?.completion_tokens ?? 0,
})

export async function* streamOpenAI(
  profile: ProviderProfile,
  body: CreateMessageRequest,
  signal: AbortSignal,
  search: boolean
): AsyncGenerator<MessageStreamEvent> {
  const messages = await toMessages(body)
  const maxTokens = getModelOutputLimit(profile, body.model)
  const capabilities = getChatCapabilities(profile, body.model)
  const useSearch = search && capabilities.search
  const effort = capabilities.adjustableEffort
    ? body.thinking.type === 'enabled'
      ? 'high'
      : 'low'
    : undefined
  if (useSearch && maxTokens !== undefined && maxTokens < 16) {
    throw new ApiError('protocol', { key: 'openaiSearchOutputLimit' })
  }
  const payload = useSearch
    ? {
        model: body.model,
        input: messages.map(({ role, content }) => ({
          role,
          content:
            typeof content === 'string'
              ? content
              : content.map((part) =>
                  part.type === 'text'
                    ? { type: 'input_text', text: part.text }
                    : { type: 'input_image', image_url: part.image_url.url, detail: 'auto' }
                ),
        })),
        stream: true,
        store: false,
        tools: [{ type: 'web_search' }],
        ...(effort && { reasoning: { effort } }),
        ...(maxTokens && { max_output_tokens: maxTokens }),
      }
    : {
        model: body.model,
        messages,
        stream: true,
        ...(effort && { reasoning_effort: effort }),
        ...(maxTokens && { max_completion_tokens: maxTokens }),
      }
  throwIfAborted(signal)
  const path = useSearch ? '/responses' : '/chat/completions'
  const response = await request(providerApiBase(profile) + path, {
    method: 'POST',
    headers: {
      ...(profile.account ? {} : { Authorization: `Bearer ${profile.apiKey}` }),
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(payload),
    signal,
  })
  if (useSearch) {
    yield* streamOpenAIResponses(response, body.model, signal)
    return
  }
  if (!response.body) throw new ApiError('protocol', '供应商返回了空响应。')
  yield { type: 'message_start', message: { id: crypto.randomUUID(), model: body.model } }
  let index = -1
  let current: 'text' | 'thinking' | null = null
  let finishReason: StopReason = 'end_turn'
  let finished = false
  let usage: MessageUsage | undefined
  const type = response.headers.get('content-type') ?? ''
  const chunks = async function* (): AsyncGenerator<Completion> {
    if (type.includes('application/json')) {
      yield (await response.json()) as Completion
      return
    }
    if (!type.includes('text/event-stream'))
      throw new ApiError('protocol', '供应商未返回 SSE 或 JSON 响应。')
    for await (const { data } of readServerSentEvents(response.body!, signal)) {
      if (data === '[DONE]') {
        finished = true
        return
      }
      let chunk: Completion
      try {
        chunk = JSON.parse(data) as Completion
      } catch {
        throw new ApiError('protocol', '供应商返回了无效的流式数据。')
      }
      if (!chunk || typeof chunk !== 'object')
        throw new ApiError('protocol', '供应商返回了无效的流式数据。')
      yield chunk
    }
  }
  for await (const chunk of chunks()) {
    throwIfAborted(signal)
    if (chunk.error) throw new ApiError('stream', chunk.error.message ?? '供应商返回错误。')
    if (chunk.usage) usage = normalizeUsage(chunk.usage)
    const choice = chunk.choices?.[0]
    if (!choice) continue
    const delta = choice.delta ?? choice.message
    const thinking = choice.delta?.reasoning_content ?? choice.delta?.reasoning
    const text = delta?.content ?? choice.delta?.refusal
    for (const [kind, content] of [
      ['thinking', thinking],
      ['text', text],
    ] as const) {
      if (!content) continue
      if (kind !== current) {
        if (current) yield { type: 'content_block_stop', index }
        index += 1
        current = kind
        yield {
          type: 'content_block_start',
          index,
          content_block:
            kind === 'thinking'
              ? { type: 'thinking', thinking: '', signature: '' }
              : { type: 'text', text: '' },
        }
      }
      yield {
        type: 'content_block_delta',
        index,
        delta:
          kind === 'thinking'
            ? { type: 'thinking_delta', thinking: content }
            : { type: 'text_delta', text: content },
      }
    }
    if (choice.finish_reason) {
      finished = true
      finishReason = choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn'
      if (choice.finish_reason === 'tool_calls')
        throw new ApiError('protocol', '此模型需要客户端工具，请选择支持直接对话的模型。')
      if (choice.finish_reason === 'content_filter')
        throw new ApiError('stream', '供应商的内容审核中止了本次回答。')
    }
    if (choice.message) finished = true
  }
  throwIfAborted(signal)
  if (!finished) throw new ApiError('interrupted', '')
  if (current) yield { type: 'content_block_stop', index }
  yield { type: 'message_delta', delta: { stop_reason: finishReason, stop_sequence: null }, usage }
  yield { type: 'message_stop' }
}
