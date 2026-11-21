import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Readable } from 'node:stream'
import { after, before, test } from 'node:test'
import { loadConfig } from '../server/config.mjs'
import { createAccountServer } from '../server/index.mjs'

const issuer = 'https://gitea.example.test'
const deepseek = 'https://api.deepseek.com'
const openai = 'https://api.openai.com/v1'
const previousOrigin = 'https://old-hub.example.test'
const actualFetch = globalThis.fetch
const challenges = new Map()
let config
let server
let address
let directory
let initial
let alice
let bob
let lastProviderRequest

const invoke = (path, { cookie, origin, body, rawBody, site = config.origin, method, headers } = {}) =>
  new Promise((resolve, reject) => {
    const req = request(address + '/api/account' + path, {
      method,
      headers: {
        Host: new URL(site).host,
        ...(cookie ? { Cookie: cookie } : {}),
        ...(origin ? { Origin: origin } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
    }, (res) => {
      const headers = new Headers()
      for (let i = 0; i < res.rawHeaders.length; i += 2) {
        headers.append(res.rawHeaders[i], res.rawHeaders[i + 1])
      }
      const status = res.statusCode
      if (status === 204) res.resume()
      resolve(new Response(status === 204 ? null : Readable.toWeb(res), { status, headers }))
    })
    req.on('error', reject)
    req.end(body ? JSON.stringify(body) : rawBody)
  })

const signIn = async (login, site = config.origin, checkOtherSite) => {
  const response = await invoke('/login', { site })
  assert.equal(response.status, 303)
  assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/)
  const authorize = new URL(response.headers.get('location'))
  assert.equal(authorize.origin, issuer)
  assert.equal(authorize.searchParams.get('scope'), 'openid profile public-only read:user')
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256')
  const redirectUri = site + '/api/account/callback'
  assert.equal(authorize.searchParams.get('redirect_uri'), redirectUri)
  const code = randomUUID()
  const state = authorize.searchParams.get('state')
  challenges.set(code, { challenge: authorize.searchParams.get('code_challenge'), login, redirectUri })
  const cookie = response.headers.getSetCookie()[0].split(';')[0]
  const finish = '/callback?' + new URLSearchParams({ state, code })
  if (checkOtherSite) {
    const foreign = await invoke(finish, { cookie, site: checkOtherSite })
    assert.equal(foreign.headers.get('location'), '/?account=expired')
  }
  const authenticated = await invoke(finish, { cookie, site })
  return {
    authenticated,
    finish,
    cookie,
    session: authenticated.headers.getSetCookie()[1]?.split(';')[0],
  }
}

const startServer = async () => {
  server = createAccountServer(config).listen(0, '127.0.0.1')
  await once(server, 'listening')
  address = 'http://127.0.0.1:' + server.address().port
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'aihub-account-'))
  const webDir = join(directory, 'web')
  await mkdir(webDir)
  await writeFile(join(webDir, 'index.html'), '<!doctype html><title>AI Hub</title>')
  config = loadConfig({
    AIHUB_PUBLIC_ORIGIN: 'https://hub.example.test',
    AIHUB_ADDITIONAL_ORIGINS: previousOrigin,
    AIHUB_GITEA_ISSUER: issuer,
    AIHUB_GITEA_CLIENT_ID: 'test-client',
    AIHUB_GITEA_CLIENT_SECRET: 'test-secret',
    AIHUB_GITEA_USERS: 'alice,bob',
    AIHUB_VAULT_KEY: randomBytes(32).toString('base64'),
    AIHUB_DATA_DIR: join(directory, 'data'),
    AIHUB_WEB_DIR: webDir,
  })
  globalThis.fetch = async (input, init) => {
    const url = new URL(input)
    if (url.href === issuer + '/login/oauth/access_token') {
      const { body } = init
      assert.equal(body.get('client_id'), 'test-client')
      assert.equal(body.get('client_secret'), 'test-secret')
      const grant = challenges.get(body.get('code'))
      assert.ok(grant)
      assert.equal(body.get('redirect_uri'), grant.redirectUri)
      challenges.delete(body.get('code'))
      const digest = createHash('sha256').update(body.get('code_verifier')).digest('base64url')
      assert.equal(digest, grant.challenge)
      return Response.json({ access_token: 'test-token:' + grant.login })
    }
    if (url.href === issuer + '/login/oauth/userinfo') {
      const login = init.headers.Authorization.split(':')[1]
      return Response.json({
        sub: 'id-' + login,
        preferred_username: login,
        picture: login === 'alice' ? '/avatars/alice' : 'https://foreign.test/avatars/bob',
      })
    }
    if (url.origin === deepseek || url.origin === 'https://api.openai.com') {
      assert.equal(init.redirect, 'error')
      const chunks = []
      if (init.body) for await (const chunk of init.body) chunks.push(chunk)
      lastProviderRequest = {
        url: url.href,
        headers: init.headers,
        payload: Buffer.concat(chunks).toString(),
      }
      if (url.pathname.endsWith('/models'))
        return Response.json({ data: [{ id: 'fixture-model' }] })
      if (url.pathname.endsWith('/files')) return Response.json({ id: 'file_fixture' })
      if (url.pathname.endsWith('/tts'))
        return new Response(new Uint8Array([1, 2]), { headers: { 'Content-Type': 'audio/pcm' } })
      if (url.pathname.endsWith('/messages') && JSON.parse(lastProviderRequest.payload).fixture === 'echo-dummy-key') {
        const credential = init.headers.get('x-api-key')
        const encoder = new TextEncoder()
        const chunks = ['data: {"message":"', credential.slice(0, 10), credential.slice(10), '"}\n\n']
        const body = new ReadableStream({
          pull(controller) {
            if (chunks.length) controller.enqueue(encoder.encode(chunks.shift()))
            else controller.close()
          },
        })
        return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
      }
      return new Response('data: {"fixture":true}\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }
    throw new Error('Unexpected outbound request')
  }
  await startServer()
})

after(async () => {
  globalThis.fetch = actualFetch
  if (server) await new Promise((done) => server.close(done))
  if (
    directory &&
    dirname(directory) === resolve(tmpdir()) &&
    basename(directory).startsWith('aihub-account-')
  )
    await rm(directory, { recursive: true, force: true })
})

test('uses a one-time S256 challenge, restricts accounts and protects session cookies', async () => {
  const guest = await invoke('/session')
  assert.deepEqual((await guest.json()).user, null)
  const denied = await signIn('charlie')
  assert.equal(denied.authenticated.headers.get('location'), '/?account=denied')
  assert.equal(denied.session, undefined)
  const missing = await invoke('/callback?state=invalid&code=fixture')
  assert.equal(missing.headers.get('location'), '/?account=expired')
  alice = await signIn('alice')
  assert.equal(alice.authenticated.headers.get('location'), '/')
  assert.match(
    alice.authenticated.headers.getSetCookie()[1],
    /^__Host-aihub-session=.*HttpOnly; SameSite=Lax; Max-Age=604800; Secure$/
  )
  const replay = await invoke(alice.finish, { cookie: alice.cookie })
  assert.equal(replay.headers.get('location'), '/?account=expired')
  bob = await signIn('bob')
  assert.deepEqual((await (await invoke('/session', { cookie: bob.session })).json()).user, {
    login: 'bob',
    avatarUrl: null,
  })
  assert.deepEqual((await (await invoke('/session', { cookie: alice.session })).json()).user, {
    login: 'alice',
    avatarUrl: issuer + '/avatars/alice',
  })
})

test('syncs authenticated workspaces with encrypted session data and lossless attachment bytes', async () => {
  const identity = async (session) => (await (await invoke('/session', { cookie: session })).json()).workspace
  const secondDevice = await signIn('alice')
  const workspace = await identity(alice.session)
  const bobWorkspace = await identity(bob.session)
  assert.match(workspace, /^[a-f0-9]{64}$/)
  assert.equal(await identity(secondDevice.session), workspace)
  assert.notEqual(bobWorkspace, workspace)
  const call = (session, account, path, options = {}) => invoke('/sync' + path, {
    ...options,
    cookie: session,
    origin: config.origin,
    headers: { 'X-AIHub-Workspace': account, ...options.headers },
  })
  const write = (session, path, revision, options) => call(session, workspace, path, {
    method: options.method ?? 'PUT',
    body: options.body,
    rawBody: options.rawBody,
    headers: {
      'X-AIHub-Revision': revision,
      'X-AIHub-Mutation': options.mutation ?? randomUUID(),
      ...options.headers,
    },
  })
  const sessionPath = '/sessions/chat-id'
  const fileId = 'file-id'
  const encodedFileId = Buffer.from(fileId).toString('base64url')
  const filePath = '/files/' + encodedFileId
  const firstBody = {
    title: 'fixture secret title', branches: ['one', 'two'], pinned: true,
    messages: [{ role: 'user', files: [{ id: fileId }] }],
  }
  const staleBody = { title: 'concurrent revision', pinned: false }
  const firstMutation = randomUUID()
  assert.equal((await invoke('/sync/changes')).status, 401)
  assert.equal((await call(bob.session, workspace, '/changes')).status, 403)
  const initial = await write(alice.session, sessionPath, 0, { body: firstBody, mutation: firstMutation })
  assert.equal(initial.status, 200)
  assert.deepEqual(await initial.json(), { revision: 1 })
  const rawBody = Buffer.from([0, 255, 3, 0, 128, 10])
  const file = await write(alice.session, filePath, 0, {
    rawBody,
    headers: { 'Content-Type': 'application/octet-stream' },
  })
  assert.deepEqual(await file.json(), { revision: 2 })
  const settings = await write(alice.session, '/settings/theme', 0, { body: { value: 'dark' } })
  assert.deepEqual(await settings.json(), { revision: 3 })
  const draftBody = { text: '继续书写', attachments: [{ id: fileId }] }
  const drafts = await write(alice.session, '/drafts/chat-id', 0, { body: draftBody })
  assert.deepEqual(await drafts.json(), { revision: 4 })
  const recovered = await call(secondDevice.session, workspace, sessionPath)
  assert.equal(recovered.headers.get('x-aihub-revision'), '1')
  assert.deepEqual(await recovered.json(), firstBody)
  const recoveredFile = await call(secondDevice.session, workspace, filePath)
  assert.equal(recoveredFile.headers.get('content-type'), 'application/octet-stream')
  assert.deepEqual(Buffer.from(await recoveredFile.arrayBuffer()), rawBody)
  assert.deepEqual(await (await call(secondDevice.session, workspace, '/settings/theme')).json(), { value: 'dark' })
  assert.deepEqual(await (await call(secondDevice.session, workspace, '/drafts/chat-id')).json(), draftBody)
  const conflict = await write(secondDevice.session, sessionPath, 0, { body: staleBody })
  assert.equal(conflict.status, 409)
  assert.deepEqual(await conflict.json(), { conflict: true, revision: 1, deleted: false })
  const renamed = await write(secondDevice.session, sessionPath, 1, { body: staleBody })
  assert.deepEqual(await renamed.json(), { revision: 5 })
  const retry = await write(alice.session, sessionPath, 0, { body: firstBody, mutation: firstMutation })
  assert.deepEqual(await retry.json(), { revision: 1 })
  const deleted = await write(secondDevice.session, sessionPath, 5, { method: 'DELETE' })
  assert.deepEqual(await deleted.json(), { revision: 6 })
  assert.equal((await call(alice.session, workspace, sessionPath)).status, 404)
  assert.equal((await call(bob.session, bobWorkspace, filePath)).status, 404)
  assert.deepEqual(await (await call(bob.session, bobWorkspace, '/changes')).json(), { changes: [], cursor: 0, more: false })
  assert.deepEqual(await (await call(alice.session, workspace, '/changes?after=4')).json(), {
    changes: [{ kind: 'sessions', id: 'chat-id', revision: 6, deleted: true }], cursor: 6, more: false,
  })
  const db = new DatabaseSync(join(config.dataDir, 'accounts.sqlite'))
  try {
    const { payload } = db.prepare('SELECT payload FROM workspace_chunks WHERE kind = ?').get('files')
    assert.notDeepEqual(Buffer.from(payload), rawBody)
    assert.equal(payload.length, rawBody.length + 28)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM workspace_file_gc').get().count, 0)
    assert.equal((await write(secondDevice.session, filePath, 2, { method: 'DELETE' })).status, 405)
    const released = await write(secondDevice.session, '/drafts/chat-id', 4, { method: 'DELETE' })
    assert.deepEqual(await released.json(), { revision: 7 })
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM workspace_file_gc').get().count, 1)
    db.prepare('UPDATE workspace_file_gc SET eligible_after = 0').run()
  } finally {
    db.close()
  }
  await new Promise((done) => server.close(done))
  await startServer()
  assert.deepEqual(await (await call(secondDevice.session, workspace, '/settings/theme')).json(), { value: 'dark' })
  const reclaimed = await call(secondDevice.session, workspace, '/changes?after=7')
  assert.deepEqual(await reclaimed.json(), {
    changes: [{ kind: 'files', id: encodedFileId, revision: 8, deleted: true }], cursor: 8, more: false,
  })
  assert.equal((await call(secondDevice.session, workspace, filePath)).status, 404)
})

const creation = {
  name: 'Account DeepSeek',
  baseUrl: deepseek,
  protocol: 'deepseek',
  models: ['fixture-model'],
  apiKey: 'not-a-real-fixture-key',
  creationId: randomUUID(),
}

test('stores encrypted keys and restores account profiles on a second device', async () => {
  const body = { method: 'POST', body: creation, origin: config.origin }
  assert.equal((await invoke('/providers', body)).status, 401)
  assert.equal(
    (await invoke('/providers', { ...body, cookie: alice.session, origin: 'https://foreign.test' }))
      .status,
    403
  )
  const stored = await invoke('/providers', { ...body, cookie: alice.session })
  assert.equal(stored.status, 201)
  initial = await stored.json()
  assert.equal(initial.apiKey, undefined)
  const retry = await invoke('/providers', { ...body, cookie: alice.session })
  assert.deepEqual(await retry.json(), initial)
  await new Promise((done) => server.close(done))
  await startServer()
  const secondDevice = await signIn('alice')
  assert.notEqual(secondDevice.session, alice.session)
  const remote = await (await invoke('/session', { cookie: secondDevice.session })).json()
  assert.deepEqual(remote.providers, [initial])
  const otherAccount = await (await invoke('/session', { cookie: bob.session })).json()
  assert.deepEqual(otherAccount.providers, [])
  const db = new DatabaseSync(join(config.dataDir, 'accounts.sqlite'), { readOnly: true })
  try {
    const stored = db.prepare('SELECT profile, encrypted_key FROM providers').get()
    assert.ok(!stored.profile.includes(creation.apiKey))
    assert.ok(!Buffer.from(stored.encrypted_key).includes(creation.apiKey))
  } finally {
    db.close()
  }
})

test('uses the exact public host for OAuth and writes, sharing vault profiles across configured domains', async () => {
  const unknownHost = await invoke('/login', { site: 'https://foreign.test', headers: {
    'X-Forwarded-Host': new URL(config.origin).host,
  } })
  assert.equal(unknownHost.status, 403)
  assert.equal((await unknownHost.json()).error.code, 'invalid_host')
  const formerSite = await signIn('alice', previousOrigin, config.origin)
  assert.equal(formerSite.authenticated.headers.get('location'), '/')
  assert.match(formerSite.authenticated.headers.getSetCookie()[1], /^__Host-.*; Secure$/)
  assert.notEqual(formerSite.session, alice.session)
  const saved = await invoke('/session', { site: previousOrigin, cookie: formerSite.session })
  assert.deepEqual((await saved.json()).providers, [initial])
  const wrongOrigin = await invoke('/logout', {
    method: 'POST', site: previousOrigin, origin: config.origin, cookie: formerSite.session,
  })
  assert.equal(wrongOrigin.status, 403)
  const validOrigin = await invoke('/logout', {
    method: 'POST', site: previousOrigin, origin: previousOrigin, cookie: formerSite.session,
  })
  assert.equal(validOrigin.status, 204)
  const mainSession = await invoke('/session', { cookie: alice.session })
  assert.equal((await mainSession.json()).user.login, 'alice')
})

test('enforces account ownership, endpoint allowlists and connection scope', async () => {
  const foreign = { cookie: bob.session, origin: config.origin }
  const owner = { cookie: alice.session, origin: config.origin }
  const base = '/providers/' + initial.id
  assert.equal((await invoke(base, { ...foreign, method: 'DELETE' })).status, 404)
  assert.equal((await invoke(base, { ...foreign, method: 'PUT', body: creation })).status, 404)
  assert.equal((await invoke(base + '/proxy/' + initial.scope + '/models', foreign)).status, 404)
  for (const protocol of ['openai', undefined]) {
    const denied = await invoke('/providers', {
      ...owner,
      method: 'POST',
      body: { ...creation, protocol, baseUrl: 'https://foreign.test' },
    })
    assert.equal(denied.status, 403)
  }
  const missingKey = await invoke(base, {
    ...owner,
    method: 'PUT',
    body: { ...creation, protocol: 'openai', baseUrl: openai, apiKey: undefined },
  })
  assert.equal((await missingKey.json()).error.code, 'key_required')
  const edit = await invoke(base, {
    ...owner,
    method: 'PUT',
    body: { ...creation, name: 'Edited', apiKey: undefined },
  })
  assert.equal((await edit.json()).scope, initial.scope)
  const rotated = await invoke(base, {
    ...owner,
    method: 'PUT',
    body: { ...creation, apiKey: 'test-key-after-rotation' },
  })
  const current = await rotated.json()
  assert.notEqual(current.scope, initial.scope)
  assert.equal((await invoke(base + '/proxy/' + initial.scope + '/models', owner)).status, 409)
  initial = current
})

test('OpenAI edits keep one profile and chat uses the updated key and model', async () => {
  const owner = { cookie: bob.session, origin: config.origin }
  const form = {
    ...creation,
    name: 'Fixture OpenAI',
    protocol: 'openai',
    baseUrl: openai,
    apiKey: 'openai-first-key',
    creationId: randomUUID(),
  }
  const created = await invoke('/providers', { ...owner, method: 'POST', body: form })
  assert.equal(created.status, 201)
  const old = await created.json()
  const path = '/providers/' + old.id
  const edited = await invoke(path, {
    ...owner, method: 'PUT',
    body: { ...form, models: ['fixture-v2'], apiKey: 'openai-second-key' },
  })
  assert.equal(edited.status, 200)
  const current = await edited.json()
  assert.equal(current.id, old.id)
  assert.notEqual(current.scope, old.scope)
  const saved = await (await invoke('/session', owner)).json()
  assert.deepEqual(saved.providers, [current])
  const payload = { model: 'fixture-v2', messages: [{role: 'user', content: 'hello'}], stream: true }
  assert.equal((await invoke(path + '/proxy/' + old.scope + '/chat/completions', {
    ...owner, method: 'POST', body: payload,
  })).status, 409)
  const reply = await invoke(path + '/proxy/' + current.scope + '/chat/completions', {
    ...owner, method: 'POST', body: payload,
  })
  assert.equal(reply.status, 200)
  assert.match(await reply.text(), /fixture/)
  assert.equal(lastProviderRequest.headers.get('Authorization'), 'Bearer openai-second-key')
  assert.equal(JSON.parse(lastProviderRequest.payload).model, 'fixture-v2')
  const searchPayload = { model: 'gpt-6.1-sol', input: 'Fixture search', tools: [{ type: 'web_search' }], stream: true }
  const search = await invoke(path + '/proxy/' + current.scope + '/responses', {
    ...owner, method: 'POST', body: searchPayload,
  })
  assert.equal(search.status, 200)
  assert.match(await search.text(), /fixture/)
  assert.equal(lastProviderRequest.url, openai + '/responses')
  assert.equal(lastProviderRequest.headers.get('Authorization'), 'Bearer openai-second-key')
  assert.deepEqual(JSON.parse(lastProviderRequest.payload), searchPayload)
  assert.equal((await invoke(path + '/proxy/' + old.scope + '/responses', {
    ...owner, method: 'POST', body: searchPayload,
  })).status, 409)
  assert.equal((await invoke(path, { ...owner, method: 'DELETE' })).status, 204)
})

test('persists catalog labels, defaults, and model parameters through updates from older clients', async () => {
  const owner = { cookie: bob.session, origin: config.origin }
  const body = {
    ...creation,
    creationId: randomUUID(),
    models: ['model-b', 'model-a'],
    modelNames: { 'model-b': 'Custom B', 'model-a': 'Custom A' },
    modelParameters: {
      'model-b': { contextWindow: 65536, maxOutputTokens: 8192 },
      'model-a': { maxOutputTokens: 2048 },
    },
    defaultModel: 'standalone-default',
  }
  const create = await invoke('/providers', { ...owner, method: 'POST', body })
  assert.equal(create.status, 201)
  const original = await create.json()
  assert.deepEqual(original.modelNames, body.modelNames)
  assert.deepEqual(original.modelParameters, body.modelParameters)
  assert.deepEqual(original.models, body.models)
  const path = '/providers/' + original.id
  for (const invalid of [
    { models: [], defaultModel: '' },
    { modelNames: { wrong: 'Unknown ID' } },
    { modelParameters: { wrong: { contextWindow: 512 } } },
    { modelParameters: { 'model-b': { contextWindow: 2.5 } } },
    { modelParameters: { 'model-b': { maxOutputTokens: 0 } } },
    { modelParameters: { 'model-b': { contextWindow: 100, maxOutputTokens: 200 } } },
  ]) {
    assert.equal((await invoke(path, { ...owner, method: 'PUT', body: { ...body, ...invalid } })).status, 400)
  }
  const legacy = await invoke(path, {
    ...owner, method: 'PUT', body: { ...creation, models: ['model-b'], apiKey: undefined },
  })
  assert.equal(legacy.status, 200)
  const fromLegacy = await legacy.json()
  assert.deepEqual(fromLegacy.modelNames, { 'model-b': 'Custom B' })
  assert.deepEqual(fromLegacy.modelParameters, { 'model-b': body.modelParameters['model-b'] })
  assert.equal(fromLegacy.defaultModel, body.defaultModel)
  assert.equal(fromLegacy.scope, original.scope)
  const emptied = await invoke(path, {
    ...owner, method: 'PUT', body: { ...body, models: [], modelNames: {}, modelParameters: {}, apiKey: undefined },
  })
  assert.equal(emptied.status, 200)
  const saved = await emptied.json()
  assert.deepEqual((await (await invoke('/session', owner)).json()).providers, [saved])
  assert.deepEqual(saved.models, [])
  assert.deepEqual(saved.modelParameters, {})
  assert.equal(saved.defaultModel, body.defaultModel)
  const chat = await invoke(path + '/proxy/' + saved.scope + '/anthropic/v1/messages', {
    ...owner, method: 'POST', body: { model: saved.defaultModel, stream: true },
  })
  assert.equal(chat.status, 200)
  await chat.text()
  assert.equal(JSON.parse(lastProviderRequest.payload).model, body.defaultModel)
  assert.equal(lastProviderRequest.headers.get('x-api-key'), creation.apiKey)
  assert.equal((await invoke(path, { ...owner, method: 'DELETE' })).status, 204)
})

test('proxies allowed authenticated requests, streams responses, and revokes sessions', async () => {
  const owner = { cookie: alice.session, origin: config.origin }
  const route = '/providers/' + initial.id + '/proxy/' + initial.scope
  assert.equal((await invoke(route + '/responses', { ...owner, method: 'POST', body: {} })).status, 404)
  const models = await invoke(route + '/models', owner)
  assert.equal((await models.json()).data[0].id, 'fixture-model')
  assert.equal(lastProviderRequest.headers.get('authorization'), 'Bearer test-key-after-rotation')
  assert.equal((await invoke(route + '/models?target=https://foreign.test', owner)).status, 400)
  assert.equal((await invoke(route + '/v1/unknown', owner)).status, 404)
  const stream = await invoke(route + '/anthropic/v1/messages', {
    ...owner,
    method: 'POST',
    body: { stream: true },
    headers: { 'X-API-Key': 'untrusted-browser-header' },
  })
  assert.equal(stream.headers.get('content-type'), 'text/event-stream')
  assert.match(await stream.text(), /fixture/)
  assert.equal(lastProviderRequest.headers.get('x-api-key'), 'test-key-after-rotation')
  assert.equal(lastProviderRequest.headers.get('cookie'), null)
  const masked = await invoke(route + '/anthropic/v1/messages', {
    ...owner, method: 'POST', body: { fixture: 'echo-dummy-key' },
  })
  assert.equal(await masked.text(), 'data: {"message":"[redacted]"}\n\n')
  const file = await invoke(route + '/anthropic/v1/files', {
    ...owner, method: 'POST',
    headers: { 'Content-Type': 'multipart/form-data; boundary=fixture' },
    rawBody: 'fixture upload',
  })
  assert.equal(file.status, 200)
  assert.match(lastProviderRequest.payload, /fixture upload/)
  assert.equal(
    (
      await invoke(route + '/v1/tools/tts', { ...owner, method: 'POST', body: { text: 'fixture' } })
    ).headers.get('content-type'),
    'audio/pcm'
  )
  assert.equal((await invoke('/logout', { ...owner, method: 'POST' })).status, 204)
  assert.equal((await invoke(route + '/models', owner)).status, 401)
  assert.equal((await (await invoke('/session', owner)).json()).user, null)
})
