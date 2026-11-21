import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyModelChoices, getDefaultModel, getModelName, moveModelRow, resolveModelLimits } from '../src/services/modelCatalog.js'

Object.assign(globalThis, { __API_ORIGIN__: 'https://api.deepseek.com' })
const { listModels } = await import('../src/services/api/models.js')

test('discovery applies checked models without losing custom labels, order, or manual IDs', () => {
  const current = [
    { id: 'model-b', name: 'My B', key: 'original-b' },
    { id: 'manual', name: 'Manual', key: 'manual-key' },
    { id: 'model-a', name: 'My A', key: 'original-a' },
  ]
  const discovered = [
    { id: 'model-a', name: 'API name for A' },
    { id: 'model-c', name: 'New C' },
    { id: 'model-b', name: 'API name for B' },
    { id: 'model-c', name: 'Repeated C' },
  ]
  assert.deepEqual(
    applyModelChoices(current, discovered, new Set(['model-b', 'model-c']), (entry) => ({
      id: entry.id, name: entry.name ?? '', key: 'new-key',
    })),
    [current[0], current[1], { id: 'model-c', name: 'New C', key: 'new-key' }]
  )
  assert.deepEqual(
    applyModelChoices(current, [], new Set(), () => { throw Error('No discovered models') }),
    current
  )
})

test('old ID-only catalogs and explicit defaults use the correct ID and display name', () => {
  assert.equal(getDefaultModel({ models: ['z', 'a'] }), 'z')
  assert.equal(getDefaultModel({ models: [], defaultModel: 'out-of-list' }), 'out-of-list')
  assert.equal(getModelName({ models: ['x'] }, 'x'), 'x')
  assert.equal(getModelName({ models: ['x'], modelNames: { x: 'Display X' } }, 'x'), 'Display X')
  assert.equal(getModelName({ models: ['constructor'], modelNames: {} }, 'constructor'), 'constructor')
})

test('model discovery accepts provider names and ID-only responses, filtering unusable entries', async (t) => {
  const profile = {
    id: 'fixture', scope: 'fixture-scope', protocol: 'openai' as const,
    baseUrl: 'https://api.openai.com/v1', name: 'OpenAI', models: [], apiKey: 'fixture',
  }
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, profile.baseUrl + '/models')
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture')
    return Response.json({ data: [
      { id: 'z', name: ' Display Z ', context_window: 1048576, max_output_tokens: 393216 },
      { id: ' a ' }, null, { id: ' ' }, { id: 'z', name: 'Ignored duplicate' },
      { id: 'x'.repeat(201) }, { id: 'n', name: 7, context_window: 0, max_output_tokens: '100' },
    ] })
  })
  assert.deepEqual(await listModels(profile), [
    { id: 'z', name: 'Display Z', limits: { contextWindow: 1048576, maxOutputTokens: 393216 } },
    { id: 'a' }, { id: 'n' },
  ])
})

test('documented limits apply only to exact model IDs on official OpenAI and yield to the API', () => {
  const official = 'https://api.openai.com/v1'
  assert.deepEqual(resolveModelLimits(official, 'openai', 'gpt-4.1'), {
    contextWindow: 1047576, maxOutputTokens: 32768,
  })
  assert.deepEqual(resolveModelLimits(official, 'openai', 'gpt-4.1', { maxOutputTokens: 8192 }), {
    contextWindow: 1047576, maxOutputTokens: 8192,
  })
  assert.deepEqual(resolveModelLimits(official, 'openai', 'gpt-4.1-custom'), {})
  assert.deepEqual(resolveModelLimits('https://example.com/v1', 'openai', 'gpt-4.1'), {})
})

test('reorders around either edge without losing model data or changing a no-op move', () => {
  const rows = [{ key: 'a', contextWindow: 100 }, { key: 'b' }, { key: 'c' }]
  assert.deepEqual(moveModelRow(rows, 'a', 'c', 'after'), [rows[1], rows[2], rows[0]])
  assert.deepEqual(moveModelRow(rows, 'c', 'a', 'before'), [rows[2], rows[0], rows[1]])
  assert.strictEqual(moveModelRow(rows, 'a', 'b', 'before'), rows)
  assert.strictEqual(moveModelRow(rows, 'b', 'missing', 'after'), rows)
})
