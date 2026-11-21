import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'

const storage = new Map<string, string>()
Object.assign(globalThis, {
  __API_ORIGIN__: 'https://api.deepseek.com',
  window: { location: { protocol: 'https:' } },
})
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
})

const {
  getConnection,
  getProvider,
  getSelection,
  LEGACY_PROVIDER_ID,
  providerApiBase,
  removeProvider,
  replaceAccountProviders,
  saveProvider,
  selectModel,
  useProviders,
} = await import('../src/services/providers.js')
const { loadAccount, removeAccountProvider, saveAccountProvider, useAccount } =
  await import('../src/services/account.js')
const { getSessionSelection, useChatStore } = await import('../src/services/chat/store.js')

const local = (id: string) => ({
  id,
  scope: id + '-scope',
  name: 'Fixture',
  protocol: 'openai' as const,
  baseUrl: 'https://api.openai.com/v1',
  models: ['model-a', 'model-b'],
  apiKey: 'local-fixture-key',
})
const account = (id: string, scope = 'scope-1') => ({
  ...local('account-' + id),
  scope,
  account: true as const,
  apiKey: '',
})
const choose = (provider: { id: string }, model = 'model-b') => ({
  providerId: provider.id,
  model,
})
const cacheSession = (id: string, connection: ReturnType<typeof choose>) => ({
  id, title: id, createdAt: 0, updatedAt: 0, messages: [], connection,
})
const parseBody = (init?: RequestInit) => JSON.parse(String(init?.body))

beforeEach(() => {
  storage.clear()
  useProviders.setState({ profiles: [], selection: { providerId: '', model: '' } })
  useAccount.setState({ mode: 'account', user: { login: 'fixture' }, endpoints: [] })
  useChatStore.setState({ sessionCache: {} })
})

test('editing a local profile keeps its ID, list position, and unrelated selections', () => {
  const first = saveProvider(local('local-edit'))
  const second = saveProvider(local('local-other'))
  selectModel(choose(second))
  const changed = saveProvider({ ...first, name: 'Edited', models: ['model-c'] })
  assert.deepEqual(useProviders.getState().profiles.map((profile) => profile.id), [first.id, second.id])
  assert.equal(changed.scope, first.scope)
  assert.deepEqual(getSelection(), choose(second))
  assert.deepEqual(getSelection(choose(first)), choose(first, 'model-c'))
  assert.equal(getConnection(choose(first)).apiKey, first.apiKey)
  assert.deepEqual(JSON.parse(storage.get('ai-hub:providers') ?? '[]'), [changed, second])
})

test('a catalog-free provider keeps a usable connection and a valid selection when its default changes', () => {
  const original = saveProvider(local('catalog-fallback'))
  selectModel(choose(original))
  useChatStore.setState({
    sessionCache: { open: cacheSession('open', choose(original)) },
  })
  const empty = saveProvider({ ...original, models: [], defaultModel: ' standalone-id ' })
  assert.deepEqual(empty.models, [])
  assert.equal(empty.scope, original.scope)
  assert.deepEqual(getSelection(), choose(empty, 'standalone-id'))
  assert.deepEqual(getSessionSelection('open'), choose(empty, 'standalone-id'))
  assert.equal(getConnection(getSessionSelection('open')).apiKey, original.apiKey)
  assert.throws(() => saveProvider({ ...empty, defaultModel: '' }), /默认模型/)
})

test('moving a local profile leaves one record and keeps existing chats on its new connection', async (t) => {
  const source = saveProvider(local('local-move'))
  const unrelated = saveProvider(local('unrelated-local'))
  selectModel(choose(source))
  useChatStore.setState({
    sessionCache: {
      open: cacheSession('open', choose(source)),
      other: cacheSession('other', choose(unrelated)),
    },
  })
  const target = account('moved', 'new-scope')
  const request = t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, '/api/account/providers')
    assert.equal(init?.method, 'POST')
    assert.equal(parseBody(init).apiKey, source.apiKey)
    return Response.json(target, { status: 201 })
  })
  assert.deepEqual(await saveAccountProvider(source, 'unused-editor-id'), target)
  assert.equal(request.mock.callCount(), 1)
  assert.equal(getProvider(source.id), undefined)
  assert.deepEqual(useProviders.getState().profiles, [unrelated, target])
  assert.deepEqual(getSelection(), choose(target))
  assert.deepEqual(getSessionSelection('open'), choose(target))
  assert.deepEqual(getSessionSelection('other'), choose(unrelated))
  assert.equal(providerApiBase(getConnection(getSessionSelection('open'))), '/api/account/providers/account-moved/proxy/new-scope')
  const saved = JSON.parse(storage.get('ai-hub:providers') ?? '[]')
  assert.deepEqual(saved, [unrelated])
  assert.ok(![...(storage.values())].some((entry) => entry.includes(source.id + '-scope')))
  replaceAccountProviders([])
  assert.throws(() => getConnection(getSessionSelection('open')), /已移除/)
  replaceAccountProviders([target])
  assert.deepEqual(getSessionSelection('open'), choose(target))
})

test('a failed move keeps the local profile, and a retry updates the same committed account ID', async (t) => {
  const source = saveProvider(local('retry-move'))
  selectModel(choose(source))
  const target = account('retry-target')
  const edited = { ...target, name: 'Retried edit', scope: 'rotated' }
  let creationId: string | undefined
  const request = t.mock.method(globalThis, 'fetch', async (url, init) => {
    const body = parseBody(init)
    if (init?.method === 'POST' && !creationId) {
      creationId = body.creationId
      assert.match(creationId ?? '', /^[0-9a-f-]{36}$/)
      throw new TypeError('response connection lost after commit')
    }
    if (init?.method === 'POST') {
      assert.equal(body.creationId, creationId)
      return Response.json(target, { status: 201 })
    }
    assert.equal(init?.method, 'PUT')
    assert.equal(url, '/api/account/providers/' + target.id)
    assert.equal(body.name, edited.name)
    return Response.json(edited)
  })
  await assert.rejects(saveAccountProvider(source, 'ignored'), /connection lost/)
  assert.deepEqual(getProvider(source.id), source)
  assert.deepEqual(getSelection(), choose(source))
  await saveAccountProvider({ ...source, name: edited.name }, 'different-editor-id')
  assert.equal(request.mock.callCount(), 3)
  assert.deepEqual(useProviders.getState().profiles, [edited])
  assert.deepEqual(getSelection(choose(source)), choose(edited))
})

test('moving the legacy DeepSeek key removes the plaintext and keeps unversioned chats working', async (t) => {
  const source = saveProvider({
    ...local(LEGACY_PROVIDER_ID),
    protocol: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-flash'],
    apiKey: 'legacy-plaintext-fixture',
  })
  assert.equal(storage.get('chat-demo:api-key'), source.apiKey)
  const { connection: _connection, ...legacyChat } = cacheSession('legacy', choose(source))
  useChatStore.setState({ sessionCache: { legacy: legacyChat } })
  const target = {
    ...source, id: 'account-legacy', scope: 'cloud-scope', account: true, apiKey: '',
  }
  t.mock.method(globalThis, 'fetch', async () => Response.json(target, { status: 201 }))
  await saveAccountProvider(source, 'editor-legacy')
  assert.deepEqual(getSessionSelection('legacy'), choose(target, 'deepseek-flash'))
  assert.equal(storage.has('chat-demo:api-key'), false)
  assert.ok(!Array.from(storage.values()).some((entry) => entry.includes(source.apiKey)))
})

test('account edits use PUT and apply the new model and scope even with a stale session refresh', async (t) => {
  const old = account('edited')
  const other = account('unrelated')
  const edited = { ...old, scope: 'scope-2', models: ['model-c'] }
  replaceAccountProviders([old, other])
  selectModel(choose(old))
  useChatStore.setState({ sessionCache: { open: cacheSession('open', choose(old)) } })
  let resolveRefresh!: (response: Response) => void
  const stale = new Promise<Response>((resolve) => { resolveRefresh = resolve })
  const request = t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url === '/api/account/session') return stale
    assert.equal(url, '/api/account/providers/' + old.id)
    assert.equal(init?.method, 'PUT')
    assert.equal(parseBody(init).apiKey, 'new-key')
    return Response.json(edited)
  })
  const refresh = loadAccount()
  await saveAccountProvider({ ...edited, apiKey: 'new-key' }, 'unused')
  assert.deepEqual(getSelection(), choose(edited, 'model-c'))
  assert.deepEqual(getSessionSelection('open'), choose(edited, 'model-c'))
  assert.equal(getConnection(choose(old)).scope, 'scope-2')
  assert.equal(getConnection(choose(old)).apiKey, '')
  resolveRefresh(Response.json({ available: true, user: { login: 'fixture' }, providers: [old, other], endpoints: [] }))
  await refresh
  assert.equal(request.mock.callCount(), 2)
  assert.deepEqual(useProviders.getState().profiles, [edited, other])
})

test('deleting a synced provider leaves its old chats disconnected and preserves other credentials', async (t) => {
  const synced = account('deleted')
  const browser = saveProvider(local('surviving-local'))
  replaceAccountProviders([synced])
  selectModel(choose(synced))
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, '/api/account/providers/' + synced.id)
    assert.equal(init?.method, 'DELETE')
    return new Response(null, { status: 204 })
  })
  await removeAccountProvider(synced.id)
  assert.deepEqual(getSelection(), choose(browser, 'model-a'))
  assert.throws(() => getConnection(choose(synced)), /已移除/)
  assert.deepEqual(getProvider(browser.id), browser)
  removeProvider(browser.id)
  assert.deepEqual(useProviders.getState().profiles, [])
})
