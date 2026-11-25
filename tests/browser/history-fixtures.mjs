import { strToU8, zipSync } from 'fflate'

export const historyFileSize = 1280 * 1024
export const historySessionCount = 40
export const historySessionId = 'archive-restored'
export const historyPicture = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGOUdOthYGBgYgADAAq7AO/tKH90AAAAAElFTkSuQmCC',
  'base64'
)

export const makeHistoryZip = (connection, { interleaved, badIndex = false }) => {
  const timestamp = '2026-11-24T12:00:00Z'
  const times = { inserted_at: timestamp, updated_at: timestamp }
  const json = (value) => strToU8(JSON.stringify(value))
  const entries = { 'manifest.json': json({ export_format_version: 3 }) }
  const index = []
  const files = {}
  for (let i = 0; i < historySessionCount; i++) {
    const withFiles = i === 32
    const id = withFiles ? historySessionId : 'archive-session-' + i
    const title = withFiles ? 'ZIP 归档恢复示例' : 'ZIP 会话 ' + i
    const pinned = withFiles
    const fragments = [{ type: 'REQUEST', content: '这是归档里的消息' }]
    const sessionFiles = {}
    if (withFiles) {
      const attachment = (id, name, bytes, mime, image = false) => {
        const exportPath = 'chat_sessions/' + historySessionId + '_files/' + id + '_' + name
        sessionFiles[exportPath] = bytes
        return {
          id, file_name: name, file_size: bytes.length, token_usage: null, inserted_at: timestamp,
          export_path: exportPath, is_image: image, width: image ? 2 : null, height: image ? 2 : null,
          ...(mime ? { ai_hub_mime_type: mime } : {}),
        }
      }
      fragments.push({ type: 'FILE', files: [
        attachment('archive-text', 'archive-proof.txt', new Uint8Array(historyFileSize).fill(65), 'text/plain'),
        attachment('archive-picture', 'archive-picture.png', historyPicture, undefined, true),
      ] })
    }
    const messages = [{
      id: 1, parent_id: null, role: 'USER', status: 'FINISHED', thinking_enabled: false,
      search_enabled: false, accumulated_token_usage: 0, inserted_at: timestamp, fragments,
    }]
    entries['chat_sessions/' + id + '.json'] = json({
      id, title, pinned, ...times, current_message_id: 1, messages, ...(withFiles ? { ai_hub: connection } : {}),
    })
    index.push({ id, title, pinned, message_count: messages.length, ...times })
    Object.assign(interleaved ? entries : files, sessionFiles)
  }
  entries['chat_session_index.json'] = json(badIndex ? index.slice(0, -1) : index)
  return zipSync(Object.assign(entries, files), { level: 0 })
}
