import { create } from 'zustand'
import { getDefaultModel, type ModelCatalog } from './modelCatalog.js'

export type ProviderProtocol = 'deepseek' | 'openai'
export type ModelSelection = { providerId: string; model: string }
export type ProviderProfile = ModelCatalog & {
  id: string
  name: string
  protocol: ProviderProtocol
  baseUrl: string
  apiKey: string
  /** The account gateway holds the Key and returns only profile metadata. */
  account?: true
  /** Changes when the endpoint or credentials change. File IDs belong to this connection. */
  scope: string
}

export const LEGACY_PROVIDER_ID = 'deepseek-default'
export const LEGACY_SCOPE = 'legacy-deepseek'
const PROFILES_KEY = 'ai-hub:providers'
const SELECTION_KEY = 'ai-hub:selection'
const MOVES_KEY = 'ai-hub:provider-moves'
const LEGACY_KEY = 'chat-demo:api-key'
const scopedKeys = [PROFILES_KEY, SELECTION_KEY, MOVES_KEY, LEGACY_KEY]
type ProviderMove = { creationId: string; accountId?: string }
let providerWorkspace: string | null = null

const workspaceKey = (workspace: string | null, key: string) =>
  workspace ? `ai-hub:account:${workspace}:${key}` : key
const providerKey = (key: string) => workspaceKey(providerWorkspace, key)

export const providerPresets = {
  deepseek: {
    name: 'DeepSeek',
    protocol: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
  },
  openai: {
    name: 'OpenAI',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4.1'],
  },
} satisfies Record<ProviderProtocol, Pick<ProviderProfile, 'name' | 'protocol' | 'baseUrl' | 'models'>>

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(providerKey(key))
  } catch {
    return null
  }
}

const save = (key: string, value: unknown) => {
  try {
    localStorage.setItem(providerKey(key), JSON.stringify(value))
    return true
  } catch {
    /* In-memory settings remain usable. */
    return false
  }
}

const readMoves = () => {
  const moves = new Map<string, ProviderMove>()
  try {
    const saved = JSON.parse(read(MOVES_KEY) ?? '{}') as Record<string, ProviderMove>
    for (const [id, move] of Object.entries(saved)) {
      if (
        typeof move?.creationId === 'string' && /^[0-9a-f-]{36}$/.test(move.creationId) &&
        (move.accountId === undefined ||
          (typeof move.accountId === 'string' && move.accountId.startsWith('account-')))
      ) {
        moves.set(id, move)
      }
    }
  } catch {
    /* Ignore malformed browser settings. */
  }
  return moves
}

let providerMoves = readMoves()
const persistMoves = () => save(MOVES_KEY, Object.fromEntries(providerMoves))

export const beginProviderMove = (id: string) => {
  const existing = providerMoves.get(id)
  if (existing) return { creationId: existing.creationId, retry: true }
  const creationId = crypto.randomUUID()
  providerMoves.set(id, { creationId })
  persistMoves()
  return { creationId, retry: false }
}

export const normalizeBaseUrl = (value: string): string => {
  const url = new URL(value.trim())
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('请输入完整的 HTTP(S) API 地址，凭据请填写到 API Key。')
  }
  return url.href.replace(/\/+$/, '')
}

const legacyProfile = (apiKey: string): ProviderProfile => ({
  id: LEGACY_PROVIDER_ID,
  ...providerPresets.deepseek,
  models: [...providerPresets.deepseek.models],
  apiKey,
  scope: LEGACY_SCOPE,
})

// Older builds could persist this automatic placeholder alongside manually saved providers.
const isLegacyPlaceholder = (profile: ProviderProfile): boolean => {
  const preset = providerPresets.deepseek
  return (
    profile.id === LEGACY_PROVIDER_ID &&
    profile.scope === LEGACY_SCOPE &&
    profile.apiKey === '' &&
    Object.keys(profile).length === 7 &&
    profile.name === preset.name &&
    profile.protocol === preset.protocol &&
    profile.baseUrl === preset.baseUrl &&
    profile.models.length === preset.models.length &&
    preset.models.every((model, index) => model === profile.models[index])
  )
}

const loadProfiles = (): ProviderProfile[] => {
  const legacyKey = read(LEGACY_KEY)?.trim()
  try {
    const saved: unknown = JSON.parse(read(PROFILES_KEY) ?? 'null')
    if (Array.isArray(saved)) {
      const profiles = saved.filter(
        (profile): profile is ProviderProfile =>
          profile &&
          profile.account !== true &&
          typeof profile.id === 'string' &&
          !providerMoves.get(profile.id)?.accountId &&
          typeof profile.name === 'string' &&
          ['deepseek', 'openai'].includes(profile.protocol) &&
          typeof profile.apiKey === 'string' &&
          typeof profile.scope === 'string' &&
          typeof profile.baseUrl === 'string' &&
          (profile.defaultModel === undefined || typeof profile.defaultModel === 'string') &&
          Array.isArray(profile.models) &&
          profile.models.every((model: unknown) => typeof model === 'string')
      )
      return profiles.flatMap((profile) => {
        if (!isLegacyPlaceholder(profile)) return [profile]
        return legacyKey ? [legacyProfile(legacyKey)] : []
      })
    }
  } catch {
    /* Fall back to the legacy key when browser settings cannot be read. */
  }
  return legacyKey && !providerMoves.get(LEGACY_PROVIDER_ID)?.accountId ? [legacyProfile(legacyKey)] : []
}

const readSelection = (): ModelSelection | null => {
  try {
    const saved = JSON.parse(read(SELECTION_KEY) ?? 'null') as ModelSelection | null
    if (typeof saved?.providerId === 'string' && typeof saved.model === 'string') return saved
  } catch {
    /* Use the first configured model. */
  }
  return null
}

const resolveSelection = (selection: ModelSelection, profiles: ProviderProfile[]): ModelSelection => {
  const movedTo = providerMoves.get(selection.providerId)?.accountId
  const profile = profiles.find((item) => item.id === (movedTo ?? selection.providerId))
  if (!profile) return selection
  return {
    providerId: profile.id,
    model: profile.models.includes(selection.model) || selection.model === profile.defaultModel
      ? selection.model
      : getDefaultModel(profile) || selection.model,
  }
}

const loadSelection = (profiles: ProviderProfile[]): ModelSelection => {
  const saved = readSelection()
  if (saved) return resolveSelection(saved, profiles)
  return {
    providerId: profiles[0]?.id ?? LEGACY_PROVIDER_ID,
    model: getDefaultModel(profiles[0]) || 'deepseek-flash',
  }
}

export const useProviders = create(() => {
  const profiles = loadProfiles()
  return { profiles, selection: loadSelection(profiles) }
})

export const setProviderWorkspace = (workspace: string | null, migrateLegacy = false) => {
  if (workspace === providerWorkspace) return
  if (workspace && migrateLegacy) {
    // A single-account installation can attribute the old browser settings to its only user.
    // Persist the new copies before removing the legacy storage.
    try {
      const current = scopedKeys.map((key) => ({ key, value: localStorage.getItem(key) }))
      for (const { key, value } of current) {
        if (value === null) continue
        const scoped = workspaceKey(workspace, key)
        if (localStorage.getItem(scoped) === null) localStorage.setItem(scoped, value)
      }
      for (const { key, value } of current) {
        if (value !== null && localStorage.getItem(workspaceKey(workspace, key)) === value)
          localStorage.removeItem(key)
      }
    } catch {
      /* Preserve the original settings if the browser could not finish moving them. */
    }
  }
  providerWorkspace = workspace
  providerMoves = readMoves()
  const profiles = loadProfiles()
  useProviders.setState({ profiles, selection: loadSelection(profiles) })
}

export const getProvider = (id: string): ProviderProfile | undefined =>
  useProviders.getState().profiles.find((profile) => profile.id === id)

export const hasProviderKey = (profile?: ProviderProfile): boolean =>
  Boolean(profile?.account || profile?.apiKey)

export const providerApiBase = (profile: ProviderProfile) =>
  profile.account
    ? `/api/account/providers/${encodeURIComponent(profile.id)}/proxy/${encodeURIComponent(profile.scope)}`
    : profile.baseUrl

export const getSelection = (selection?: ModelSelection): ModelSelection => {
  const state = useProviders.getState()
  return resolveSelection(selection ?? state.selection, state.profiles)
}

export const getConnection = (selection?: ModelSelection): ProviderProfile => {
  const provider = getProvider(getSelection(selection).providerId)
  if (!provider) throw new Error('此会话的供应商配置已移除，请重新选择供应商。')
  return { ...provider, models: [...provider.models] }
}

export const selectModel = (selection: ModelSelection, remember = true) => {
  const resolved = getSelection(selection)
  if (remember) save(SELECTION_KEY, resolved)
  useProviders.setState({ selection: resolved })
}

export const replaceAccountProviders = (synced: ProviderProfile[]) => {
  const current = useProviders.getState()
  const local = current.profiles.filter((profile) => !profile.account)
  const profiles = [...local, ...synced]
  const saved = readSelection()
  const preferred = saved && resolveSelection(saved, profiles)
  let selection =
    preferred && synced.some((profile) => profile.id === preferred.providerId)
      ? preferred
      : resolveSelection(current.selection, profiles)
  const selected = profiles.find((profile) => profile.id === selection.providerId)
  if (!selected || (!hasProviderKey(selected) && synced.length)) {
    const next = synced[0] ?? local.find(hasProviderKey) ?? local[0]
    selection = { providerId: next?.id ?? '', model: getDefaultModel(next) }
  }
  useProviders.setState({ profiles, selection })
}

const saveLocalProfiles = (profiles: ProviderProfile[]) =>
  save(PROFILES_KEY, profiles.filter((profile) => !profile.account))

const removeLegacyKey = () => {
  try {
    localStorage.removeItem(providerKey(LEGACY_KEY))
  } catch {
    /* In-memory settings remain usable. */
  }
}

export const applyAccountProvider = (profile: ProviderProfile, movedFrom?: string) => {
  const current = useProviders.getState()
  if (movedFrom) {
    const pending = providerMoves.get(movedFrom)
    if (pending) {
      providerMoves.set(movedFrom, { ...pending, accountId: profile.id })
      // Persist the redirect before removing the original profile, so a reload keeps old chats usable.
      if (persistMoves() && saveLocalProfiles(current.profiles.filter((p) => p.id !== movedFrom))) {
        if (movedFrom === LEGACY_PROVIDER_ID) removeLegacyKey()
      }
    }
  }
  const profiles = current.profiles
    .filter((item) => item.id !== movedFrom)
    .map((item) => (item.id === profile.id ? profile : item))
  if (!profiles.some((item) => item.id === profile.id)) profiles.push(profile)
  const selection = resolveSelection(current.selection, profiles)
  if (selection.providerId === profile.id) save(SELECTION_KEY, selection)
  useProviders.setState({ profiles, selection })
}

export const saveProvider = (profile: ProviderProfile) => {
  if (profile.account)
    throw new Error('Account profiles must be saved through the account service.')
  const baseUrl = normalizeBaseUrl(profile.baseUrl)
  const models = [...new Set(profile.models.map((model) => model.trim()).filter(Boolean))]
  const modelNames = profile.modelNames
  const modelParameters = profile.modelParameters
  const defaultModel = profile.defaultModel?.trim()
  if (!profile.name.trim() || (!models.length && !defaultModel))
    throw new Error('请填写供应商名称，并添加目录模型或设置默认模型 ID。')
  const previous = getProvider(profile.id)
  const changed =
    previous &&
    (previous.baseUrl !== baseUrl ||
      previous.apiKey !== profile.apiKey.trim() ||
      previous.protocol !== profile.protocol)
  const next = {
    ...profile,
    name: profile.name.trim(),
    baseUrl,
    models,
    ...(modelNames && {
      modelNames: Object.fromEntries(
        models.flatMap((id) =>
          Object.hasOwn(modelNames, id) && typeof modelNames[id] === 'string' && modelNames[id].trim()
            ? [[id, modelNames[id].trim()]]
            : []
        )
      ),
    }),
    ...(profile.defaultModel !== undefined && { defaultModel }),
    ...(modelParameters && {
      modelParameters: Object.fromEntries(
        Object.entries(modelParameters).filter(([id]) => models.includes(id))
      ),
    }),
    apiKey: profile.apiKey.trim(),
    scope: changed ? crypto.randomUUID() : profile.scope,
  }
  const profiles = useProviders.getState().profiles.map((item) => (item.id === next.id ? next : item))
  if (!previous) profiles.push(next)
  saveLocalProfiles(profiles)
  useProviders.setState({ profiles })
  if (profile.id === LEGACY_PROVIDER_ID) {
    try {
      localStorage.setItem(providerKey(LEGACY_KEY), next.apiKey)
    } catch {
      /* Legacy compatibility. */
    }
  }
  const current = useProviders.getState().selection
  if (current.providerId === next.id) selectModel(current)
  return next
}

export const removeProvider = (id: string) => {
  if (getProvider(id)?.account) return
  if (id === LEGACY_PROVIDER_ID) removeLegacyKey()
  const profiles = useProviders.getState().profiles.filter((profile) => profile.id !== id)
  saveLocalProfiles(profiles)
  useProviders.setState({ profiles })
  if (useProviders.getState().selection.providerId === id)
    selectModel({ providerId: profiles[0]?.id ?? '', model: getDefaultModel(profiles[0]) })
}

export const supportsDeepSeekFeatures = (profile: ProviderProfile | undefined) =>
  profile?.protocol === 'deepseek'
