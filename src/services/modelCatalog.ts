export type ModelParameters = { contextWindow?: number; maxOutputTokens?: number }

export type ModelEntry = { id: string; name?: string; limits?: ModelParameters }

export type ModelCatalog = {
  models: string[]
  modelNames?: Record<string, string>
  modelParameters?: Record<string, ModelParameters>
  defaultModel?: string
}

export const isTokenCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

export const getModelParameters = (catalog: ModelCatalog | undefined, id: string) => {
  const parameters = catalog?.modelParameters
  return parameters && Object.hasOwn(parameters, id) ? parameters[id] : undefined
}

export const getModelOutputLimit = (catalog: ModelCatalog | undefined, id: string) => {
  const limit = getModelParameters(catalog, id)?.maxOutputTokens
  return isTokenCount(limit) ? limit : undefined
}

// Model specs from https://developers.openai.com/api/docs/models. Only match exact IDs on the official endpoint.
const gpt41 = { contextWindow: 1047576, maxOutputTokens: 32768 }
const gpt6 = { contextWindow: 1050000, maxOutputTokens: 128000 }
const openaiLimits = new Map([
  ['gpt-4.1', gpt41],
  ['gpt-4.1-2025-04-14', gpt41],
  ['gpt-4.1-mini', gpt41],
  ['gpt-4.1-mini-2025-04-14', gpt41],
  ['gpt-6.1-sol', gpt6],
  ['gpt-6.2-sol', gpt6],
])

export const resolveModelLimits = (
  baseUrl: string,
  protocol: string,
  id: string,
  reported?: ModelParameters
): ModelParameters => {
  const documented =
    protocol === 'openai' && baseUrl === 'https://api.openai.com/v1'
      ? openaiLimits.get(id)
      : undefined
  return { ...documented, ...reported }
}

export const moveModelRow = <T extends { key: string }>(
  rows: T[],
  from: string,
  to: string,
  edge: 'before' | 'after'
): T[] => {
  const source = rows.findIndex((row) => row.key === from)
  const target = rows.findIndex((row) => row.key === to)
  if (source < 0 || target < 0 || source === target) {
    return rows
  }
  const destination = target + Number(edge === 'after') - Number(source < target)
  if (destination === source) {
    return rows
  }
  const ordered = [...rows]
  const [row] = ordered.splice(source, 1)
  ordered.splice(destination, 0, row)
  return ordered
}

export const getDefaultModel = (catalog?: ModelCatalog): string =>
  catalog?.defaultModel || catalog?.models[0] || ''

export const getModelName = (catalog: ModelCatalog | undefined, id: string): string => {
  const names = catalog?.modelNames
  const name = names && Object.hasOwn(names, id) ? names[id] : undefined
  return typeof name === 'string' && name ? name : id
}

export const applyModelChoices = <T extends ModelEntry>(
  current: T[],
  found: ModelEntry[],
  selected: ReadonlySet<string>,
  createRow: (model: ModelEntry) => T
): T[] => {
  const available = new Set(found.map(({ id }) => id))
  const kept = current.filter(({ id }) => !available.has(id.trim()) || selected.has(id.trim()))
  const existing = new Set(kept.map(({ id }) => id.trim()))
  for (const model of found) {
    if (!selected.has(model.id) || existing.has(model.id)) {
      continue
    }
    kept.push(createRow(model))
    existing.add(model.id)
  }
  return kept
}
