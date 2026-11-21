import assert from 'node:assert/strict'
import { test } from 'node:test'

const storage = new Map<string, string>([['chat-demo:api-key', 'legacy-fixture-credential']])
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
  configurable: true,
})
const providers = await import('../src/services/providers.js')

test('migrates the existing browser key and keeps the legacy connection scope', () => {
  const legacy = providers.getProvider(providers.LEGACY_PROVIDER_ID)
  assert.equal(legacy?.apiKey, 'legacy-fixture-credential')
  assert.equal(legacy?.scope, providers.LEGACY_SCOPE)
  assert.equal(storage.get('chat-demo:api-key'), 'legacy-fixture-credential')
})

test('credentials and endpoint changes invalidate file scope without changing an in-flight snapshot', () => {
  const profile = providers.saveProvider({
    id: 'provider-fixture',
    name: 'Fixture',
    protocol: 'openai',
    baseUrl: 'https://example.com/v1/',
    apiKey: 'first-fixture-credential',
    models: ['model-a'],
    scope: 'first-scope',
  })
  const selection = { providerId: profile.id, model: 'model-a' }
  const snapshot = providers.getConnection(selection)
  const updated = providers.saveProvider({ ...profile, apiKey: 'second-fixture-credential' })
  assert.notEqual(updated.scope, snapshot.scope)
  assert.equal(snapshot.apiKey, 'first-fixture-credential')
  assert.equal(updated.baseUrl, 'https://example.com/v1')
  assert.equal(
    providers.getProvider(providers.LEGACY_PROVIDER_ID)?.apiKey,
    'legacy-fixture-credential'
  )
})

test('a removed session provider fails explicitly instead of routing to another account', () => {
  providers.selectModel({ providerId: 'provider-fixture', model: 'model-a' })
  providers.removeProvider('provider-fixture')
  assert.throws(
    () => providers.getConnection({ providerId: 'provider-fixture', model: 'model-a' }),
    /已移除/
  )
  assert.equal(
    providers.getProvider(providers.LEGACY_PROVIDER_ID)?.apiKey,
    'legacy-fixture-credential'
  )
})

test('rejects credentials embedded in endpoint URLs', () => {
  assert.throws(() => providers.normalizeBaseUrl('https://user:password@example.com/v1'))
  assert.throws(() => providers.normalizeBaseUrl('javascript:alert(1)'))
  assert.throws(() => providers.normalizeBaseUrl('https://example.com/v1?key=fixture'))
})

test('isolates local provider credentials between signed-in accounts', () => {
  providers.setProviderWorkspace('first')
  assert.equal(providers.getProvider(providers.LEGACY_PROVIDER_ID), undefined)
  providers.saveProvider({
    id: 'browser-account-provider', name: 'Local fixture', protocol: 'openai',
    baseUrl: 'https://example.test/v1', models: ['fixture-model'],
    apiKey: 'only-first-account', scope: 'fixture-scope',
  })
  providers.setProviderWorkspace('second')
  assert.equal(providers.getProvider('browser-account-provider'), undefined)
  assert.equal(providers.getProvider(providers.LEGACY_PROVIDER_ID), undefined)
  providers.setProviderWorkspace('first')
  assert.equal(providers.getProvider('browser-account-provider')?.apiKey, 'only-first-account')

  providers.setProviderWorkspace('sole-user', true)
  assert.equal(providers.getProvider(providers.LEGACY_PROVIDER_ID)?.apiKey, 'legacy-fixture-credential')
  assert.equal(storage.has('chat-demo:api-key'), false)
  providers.setProviderWorkspace('second')
  assert.equal(providers.getProvider(providers.LEGACY_PROVIDER_ID), undefined)
  providers.setProviderWorkspace(null)
})
