import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const routes = new Map([
  ['GET /models', { auth: 'bearer' }],
  ['POST /chat/completions', { auth: 'bearer', protocol: 'openai' }],
  ['POST /responses', { auth: 'bearer', protocol: 'openai', baseUrl: 'https://api.openai.com/v1' }],
  ['POST /anthropic/v1/messages', { auth: 'key', protocol: 'deepseek' }],
  ['POST /anthropic/v1/files', { auth: 'key', protocol: 'deepseek', multipart: true }],
  ['POST /v1/tools/asr', { auth: 'bearer', protocol: 'deepseek', multipart: true }],
  ['POST /v1/tools/tts', { auth: 'bearer', protocol: 'deepseek' }],
])
const fileRoute = /^\/anthropic\/v1\/files\/[a-zA-Z0-9_-]{1,160}$/
const safeMime =
  /^(application\/(json|octet-stream)|text\/(event-stream|plain)|audio\/[a-z0-9.+-]+)(?:[; ]|$)/i
const bodyLimit = 96 * 1024 * 1024
const filesBeta = 'files-api-2025-04-14'

async function* redactCredential(body, credential) {
  const decoder = new TextDecoder()
  const forms = [...new Set([credential, JSON.stringify(credential).slice(1, -1)])]
    .sort((a, b) => b.length - a.length)
  const redact = (text) => forms.reduce((value, secret) => value.replaceAll(secret, '[redacted]'), text)
  let tail = ''
  for await (const chunk of body) {
    const text = redact(tail + decoder.decode(chunk, { stream: true }))
    let keep = 0
    for (const secret of forms) {
      for (let size = Math.min(secret.length - 1, text.length); size > keep; size--) {
        if (text.endsWith(secret.slice(0, size))) {
          keep = size
          break
        }
      }
    }
    tail = keep ? text.slice(-keep) : ''
    const ready = text.slice(0, text.length - keep)
    if (ready) yield ready
  }
  const final = redact(tail + decoder.decode())
  if (final) yield final
}

export const createProxy = (config, vault, fail) => {
  const active = new Map()
  return async (req, res, owner, id, scope, path) => {
    const deletingFile = req.method === 'DELETE' && fileRoute.test(path)
    const route = deletingFile
      ? { auth: 'key', protocol: 'deepseek' }
      : routes.get(req.method + ' ' + path)
    if (!route) return fail(res, 404, 'route_not_found')
    const profile = vault.connection(owner, id, scope)
    if (!profile) return fail(res, 404, 'provider_not_found')
    if (profile.changed) return fail(res, 409, 'provider_changed')
    if (
      !config.endpoints.has(profile.baseUrl) ||
      config.endpoints.get(profile.baseUrl) !== profile.protocol
    )
      return fail(res, 403, 'endpoint_not_allowed')
    if ((route.protocol && route.protocol !== profile.protocol) || (route.baseUrl && route.baseUrl !== profile.baseUrl))
      return fail(res, 404, 'route_not_found')
    if ((active.get(owner) ?? 0) >= 8) return fail(res, 429, 'too_many_requests')
    const declaredSize = Number(req.headers['content-length'])
    if (declaredSize > bodyLimit) return fail(res, 413, 'request_too_large')

    const headers = new Headers()
    headers.set(
      route.auth === 'key' ? 'x-api-key' : 'Authorization',
      route.auth === 'key' ? profile.apiKey : `Bearer ${profile.apiKey}`
    )
    if (
      route.auth === 'key' &&
      (route.multipart || deletingFile || req.headers['anthropic-beta'] === filesBeta)
    )
      headers.set('anthropic-beta', filesBeta)
    if (req.headers.accept === 'text/event-stream') headers.set('Accept', 'text/event-stream')
    if (req.method === 'POST') {
      const type = req.headers['content-type'] || ''
      if (
        route.multipart
          ? !/^multipart\/form-data;\s*boundary=/i.test(type)
          : !/^application\/json(?:;|$)/i.test(type)
      )
        return fail(res, 415, 'content_type_not_supported')
      headers.set('Content-Type', type)
      if (Number.isSafeInteger(declaredSize) && declaredSize > 0)
        headers.set('Content-Length', String(declaredSize))
    }

    active.set(owner, (active.get(owner) ?? 0) + 1)
    const controller = new AbortController()
    res.once('close', () => controller.abort())
    let tooLarge = false
    let length = 0
    async function* streamBody() {
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        length += chunk.length
        if (length > bodyLimit) {
          tooLarge = true
          throw new Error('Request too large')
        }
        yield chunk
      }
    }
    try {
      const upstream = await fetch(profile.baseUrl + path, {
        method: req.method,
        headers,
        body: req.method === 'POST' ? streamBody() : undefined,
        duplex: 'half',
        redirect: 'error',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(600000)]),
      })
      const type = upstream.headers.get('content-type') || ''
      if (upstream.body && !safeMime.test(type)) {
        await upstream.body.cancel()
        return fail(res, 502, 'invalid_provider_response')
      }
      res.statusCode = upstream.status
      if (!upstream.body) return res.end()
      res.setHeader('Content-Type', type)
      res.flushHeaders()
      const source = Readable.fromWeb(upstream.body)
      const redact = profile.apiKey.length >= 12 && /^(application\/json|text\/)/i.test(type)
      await pipeline(redact ? Readable.from(redactCredential(source, profile.apiKey)) : source, res)
    } catch {
      if (res.headersSent) res.destroy()
      else if (!res.destroyed)
        fail(res, tooLarge ? 413 : 502, tooLarge ? 'request_too_large' : 'provider_unavailable')
    } finally {
      const remaining = active.get(owner) - 1
      if (remaining) active.set(owner, remaining)
      else active.delete(owner)
    }
  }
}
