import { resolve, sep } from 'node:path'

const defaultProviders = {
  'https://api.deepseek.com': 'deepseek',
  'https://api.openai.com/v1': 'openai',
  'https://openrouter.ai/api/v1': 'openai',
  'https://api.siliconflow.cn/v1': 'openai',
  'https://dashscope.aliyuncs.com/compatible-mode/v1': 'openai',
}

export const providerUrl = (value) => {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('A provider URL must use HTTPS and contain only its host and path.')
  }
  return url.href.replace(/\/+$/, '')
}

const origin = (value, allowLoopback = false) => {
  const url = new URL(value)
  if (url.href !== url.origin + '/') throw new Error('Expected an origin without a path.')
  const local = allowLoopback && url.hostname === '127.0.0.1' && url.protocol === 'http:'
  if (!local && url.protocol !== 'https:') throw new Error('Expected an HTTPS origin.')
  return url.origin
}

export const loadConfig = (env = process.env) => {
  const required = (name) => {
    const value = env[name]?.trim()
    if (!value) throw new Error(`${name} is required.`)
    return value
  }
  const allowed = JSON.parse(env.AIHUB_PROVIDER_ENDPOINTS || JSON.stringify(defaultProviders))
  const endpoints = new Map(
    Object.entries(allowed).map(([url, protocol]) => {
      if (!['deepseek', 'openai'].includes(protocol)) throw new Error('Unknown provider protocol.')
      return [providerUrl(url), protocol]
    })
  )
  const key = Buffer.from(required('AIHUB_VAULT_KEY'), 'base64')
  if (key.length !== 32) throw new Error('AIHUB_VAULT_KEY must contain 32 random bytes in base64.')
  const users = new Set(
    required('AIHUB_GITEA_USERS')
      .toLowerCase()
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
  )
  if (!users.size) throw new Error('AIHUB_GITEA_USERS must name at least one Gitea account.')
  const port = Number(env.AIHUB_PORT || 8788)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid AIHUB_PORT.')
  const dataDir = resolve(env.AIHUB_DATA_DIR || 'data')
  const webDir = resolve(env.AIHUB_WEB_DIR || 'dist')
  if (dataDir === webDir || dataDir.startsWith(webDir + sep))
    throw new Error('AIHUB_DATA_DIR must be outside the static Web directory.')
  return {
    origin: origin(required('AIHUB_PUBLIC_ORIGIN'), true),
    additionalOrigins: (env.AIHUB_ADDITIONAL_ORIGINS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => origin(value, true)),
    issuer: origin(required('AIHUB_GITEA_ISSUER')),
    clientId: required('AIHUB_GITEA_CLIENT_ID'),
    clientSecret: required('AIHUB_GITEA_CLIENT_SECRET'),
    users,
    key,
    endpoints,
    port,
    dataDir,
    webDir,
  }
}
