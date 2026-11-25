import { throwIfAborted } from '../../utils/abort.js'
import { getVisibleMessages } from './branches.js'
import type { Message, Session } from './types.js'

export const CHAT_SEARCH_LIMIT = 80

export const normalizeSearchText = (text: string): string => text.replace(/\s+/g, ' ').trim()

export const createChatSearchPattern = (text: string): RegExp | null => {
  const term = normalizeSearchText(text)
  return term ? new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu') : null
}

const messageText = (message: Message): string => {
  if (message.role === 'user') {
    return message.content
  }
  return message.blocks
    .flatMap((block) => (block.type === 'text' && !block.isTemplate ? [block.text] : []))
    .join(' ')
}

const clipMatch = (text: string, start: number, length: number): string => {
  const from = Math.max(0, start - 28)
  const to = Math.min(text.length, Math.max(from + 115, start + length + 24))
  return `${from ? '…' : ''}${text.slice(from, to).trim()}${to < text.length ? '…' : ''}`
}

export type MessageSearchHit = {
  sessionId: string
  messageId: string
  snippet: string
  time: number
}

export type MessageSearchResult = {
  hits: MessageSearchHit[]
  limited: boolean
  failed: boolean
}

/** 逐条读取历史，保留可跳转到的当前分支消息。 */
export const searchChatMessages = async (
  ids: readonly string[],
  pattern: RegExp,
  read: (id: string) => Promise<Session | undefined>,
  signal: AbortSignal,
  onProgress?: (result: MessageSearchResult) => void
): Promise<MessageSearchResult> => {
  const hits: MessageSearchHit[] = []
  let failed = false
  for (const id of ids) {
    throwIfAborted(signal)
    const session = await read(id).catch(() => undefined)
    throwIfAborted(signal)
    if (!session) {
      failed = true
      continue
    }
    const previousHitCount = hits.length
    const messages = getVisibleMessages(session)
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]
      const text = normalizeSearchText(messageText(message))
      const match = pattern.exec(text)
      if (!match) {
        continue
      }
      if (hits.length === CHAT_SEARCH_LIMIT) {
        return { hits, limited: true, failed }
      }
      hits.push({
        sessionId: id,
        messageId: message.id,
        snippet: clipMatch(text, match.index, match[0].length),
        time: message.createdAt,
      })
    }
    if (hits.length > previousHitCount) {
      onProgress?.({ hits: [...hits], limited: false, failed })
    }
  }
  return { hits, limited: false, failed }
}
