import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadConfig, providerUrl } from './config.mjs'
import { createOAuth } from './oauth.mjs'
import { createProxy } from './proxy.mjs'
import { openVault } from './vault.mjs'

const root = '/api/account'
const providerPath =
  /^\/api\/account\/providers\/(account-[a-f0-9-]{36})(?:\/proxy\/([a-f0-9-]{36})(\/.+))?$/
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
}

const json = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}
const fail = (res, status, code) => json(res, status, { error: { code, message: code } })

const readProfile = async (req, endpoints) => {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return null
  let size = 0
  const chunks = []
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > 3 * 1024 * 1024) return null
    chunks.push(chunk)
  }
  try {
    const { name, protocol, baseUrl, models, modelNames, modelParameters, defaultModel, apiKey, creationId } = JSON.parse(
      Buffer.concat(chunks).toString('utf8')
    )
    const endpoint = providerUrl(baseUrl)
    if (!['deepseek', 'openai'].includes(protocol) || endpoints.get(endpoint) !== protocol)
      return { error: 'endpoint_not_allowed', status: 403 }
    if (
      typeof name !== 'string' ||
      !name.trim() ||
      name.length > 100 ||
      !Array.isArray(models) ||
      (defaultModel !== undefined && (typeof defaultModel !== 'string' || defaultModel.length > 200)) ||
      (!models.length && !defaultModel?.trim()) ||
      models.length > 512 ||
      models.some((model) => typeof model !== 'string' || !model.trim() || model.length > 200) ||
      (apiKey !== undefined && (typeof apiKey !== 'string' || !/^[!-~]{1,2048}$/.test(apiKey)))
    )
      return null
    const ids = new Set(models.map((model) => model.trim()))
    let labels
    if (modelNames !== undefined) {
      if (modelNames === null || typeof modelNames !== 'object' || Array.isArray(modelNames))
        return null
      const entries = Object.entries(modelNames)
      if (entries.some(([id, label]) => !ids.has(id) || typeof label !== 'string' || label.length > 200))
        return null
      labels = Object.fromEntries(entries.map(([id, label]) => [id, label.trim()]))
    }
    let parameters
    if (modelParameters !== undefined) {
      if (!modelParameters || typeof modelParameters !== 'object' || Array.isArray(modelParameters)) return null
      const entries = []
      for (const [id, value] of Object.entries(modelParameters)) {
        if (!ids.has(id) || !value || typeof value !== 'object' || Array.isArray(value)) return null
        const { contextWindow, maxOutputTokens } = value
        if ([contextWindow, maxOutputTokens].some(
          (count) => count !== undefined && (!Number.isSafeInteger(count) || count <= 0)
        )) return null
        if (contextWindow !== undefined && maxOutputTokens !== undefined && maxOutputTokens > contextWindow)
          return null
        if (contextWindow !== undefined || maxOutputTokens !== undefined)
          entries.push([id, { contextWindow, maxOutputTokens }])
      }
      parameters = Object.fromEntries(entries)
    }
    return {
      values: {
        name: name.trim(),
        protocol,
        baseUrl: endpoint,
        models: [...ids],
        ...(labels && { modelNames: labels }),
        ...(parameters && { modelParameters: parameters }),
        ...(defaultModel !== undefined && { defaultModel: defaultModel.trim() }),
      },
      apiKey,
      creationId,
    }
  } catch {
    return null
  }
}

const serveFile = async (config, req, res, pathname) => {
  if (!['GET', 'HEAD'].includes(req.method)) return fail(res, 405, 'method_not_allowed')
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1))
  if (relative.split(/[\\/]/).some((part) => !part || part.startsWith('.')))
    return fail(res, 404, 'not_found')
  const file = resolve(config.webDir, relative)
  if (!file.startsWith(config.webDir + sep)) return fail(res, 404, 'not_found')
  const info = await stat(file).catch(() => null)
  if (!info?.isFile()) return fail(res, 404, 'not_found')
  res.writeHead(200, {
    'Content-Length': info.size,
    'Content-Type': mime[extname(file)] || 'application/octet-stream',
    'Cache-Control': relative.startsWith('static/') ? 'public, max-age=86400' : 'no-cache',
  })
  if (req.method === 'HEAD') return res.end()
  const stream = createReadStream(file)
  res.on('close', () => stream.destroy())
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}

export const createAccountServer = (config) => {
  const origins = new Set([config.origin, ...(config.additionalOrigins ?? [])])
  const originsByHost = new Map([...origins].map((origin) => [new URL(origin).host, origin]))
  if (originsByHost.size !== origins.size) throw new Error('Each account origin must have a distinct host.')
  const vault = openVault(config)
  const sites = new Map(
    [...originsByHost].map(([host, origin]) => [host, { origin, oauth: createOAuth(config, vault, origin) }])
  )
  const proxy = createProxy(config, vault, fail)
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Cache-Control', 'no-store')
    try {
      if (!req.url?.startsWith('/') || req.url.startsWith('//'))
        return fail(res, 400, 'bad_request')
      const url = new URL(req.url, config.origin)
      const { pathname: path } = url
      if (!path.startsWith(root + '/')) return await serveFile(config, req, res, path)
      const { method } = req
      const site = sites.get(req.headers.host?.toLowerCase())
      if (!site) return fail(res, 403, 'invalid_host')
      const { origin, oauth } = site
      if (method !== 'GET' && req.headers.origin !== origin)
        return fail(res, 403, 'invalid_origin')
      if (path === root + '/login' && method === 'GET') return oauth.login(req, res)
      if (path === root + '/callback' && method === 'GET')
        return await oauth.callback(req, res, url.searchParams)
      if (path === root + '/logout' && method === 'POST') {
        oauth.logout(req, res)
        return res.writeHead(204).end()
      }
      const session = oauth.session(req)
      if (path === root + '/session' && method === 'GET') {
        return json(res, 200, {
          available: true,
          user: session ? { login: session.login, avatarUrl: vault.avatar(session.owner) } : null,
          workspace: session ? vault.workspace.identity(session.owner) : null,
          migrateLegacyProviders: Boolean(session && config.users.size === 1),
          providers: session ? vault.list(session.owner) : [],
          endpoints: session
            ? [...config.endpoints].map(([baseUrl, protocol]) => ({ baseUrl, protocol }))
            : [],
        })
      }
      if (!session) return fail(res, 401, 'login_required')
      if (path.startsWith(root + '/sync/')) {
        if (req.headers['x-aihub-workspace'] !== vault.workspace.identity(session.owner))
          return fail(res, 403, 'workspace_account_changed')
        return await vault.workspace.route(req, res, session.owner, path.slice(root.length), url.searchParams, json, fail)
      }
      const match = providerPath.exec(path)
      const [, id, scope, upstreamPath] = match || []
      if (scope) {
        if (url.search) return fail(res, 400, 'bad_request')
        return await proxy(req, res, session.owner, id, scope, upstreamPath)
      }
      if (match && method === 'DELETE') {
        if (!vault.remove(session.owner, id)) return fail(res, 404, 'provider_not_found')
        return res.writeHead(204).end()
      }
      if ((method === 'POST' && path === root + '/providers') || (method === 'PUT' && match)) {
        const form = await readProfile(req, config.endpoints)
        if (!form) return fail(res, 400, 'invalid_profile')
        if (form.error) return fail(res, form.status, form.error)
        if (
          !id &&
          (typeof form.creationId !== 'string' || !/^[a-f0-9-]{36}$/.test(form.creationId))
        )
          return fail(res, 400, 'invalid_profile')
        const profile = vault.save(session.owner, form.values, form.apiKey, id, form.creationId)
        if (!profile) return fail(res, 404, 'provider_not_found')
        if (profile.error) return fail(res, 400, profile.error)
        return json(res, id ? 200 : 201, profile)
      }
      return fail(res, 404, 'route_not_found')
    } catch {
      // Errors may include credentials in an upstream request. Return and log only a generic failure.
      if (res.headersSent) res.destroy()
      else if (!res.destroyed) fail(res, 500, 'server_error')
    }
  })
  server.on('close', () => vault.close())
  return server
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.umask(0o077)
  const config = loadConfig()
  createAccountServer(config).listen(config.port, '127.0.0.1', () =>
    console.log(`AI Hub listening on 127.0.0.1:${config.port}`)
  )
}
