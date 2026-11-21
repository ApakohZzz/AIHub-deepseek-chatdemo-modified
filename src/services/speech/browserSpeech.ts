import type { Nodes } from 'mdast'
import { toMdAst } from '../markdown/parse.js'

const extractText = (node: Nodes): string => {
  switch (node.type) {
    case 'text':
    case 'inlineCode':
      return node.value
    case 'break':
      return ' '
    case 'code':
    case 'math':
    case 'inlineMath':
    case 'html':
    case 'table':
      return ''
    default:
      if (!('children' in node)) {
        return ''
      }
      return node.children
        .map(extractText)
        .join(['root', 'list', 'listItem', 'blockquote'].includes(node.type) ? ' ' : '')
  }
}

export const splitSpeechText = (markdown: string): string[] => {
  const text = extractText(toMdAst(markdown, { sources: [], disableLink: true }))
    .replace(/\s+/g, ' ')
    .trim()
  const chunks: string[] = []
  let offset = 0
  const length = 220
  while (offset < text.length) {
    let end = Math.min(offset + length, text.length)
    if (end < text.length) {
      const window = text.slice(offset, end)
      const boundary = Math.max(
        ...[' ', '。', '！', '？', '，'].map((char) => window.lastIndexOf(char))
      )
      if (boundary >= length / 2) {
        end = offset + boundary + 1
      } else if (text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) {
        end -= 1
      }
    }
    chunks.push(text.slice(offset, end).trim())
    offset = end
  }
  return chunks
}

export const speechLanguage = (text: string, fallback: string): string => {
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) {
    return 'ja-JP'
  }
  if (/\p{Script=Hangul}/u.test(text)) {
    return 'ko-KR'
  }
  if (/\p{Script=Han}/u.test(text)) {
    return 'zh-CN'
  }
  if (/[a-z]/i.test(text)) {
    return 'en-US'
  }
  return fallback
}
