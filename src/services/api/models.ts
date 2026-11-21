import { request } from './client.js'
import { isTokenCount, type ModelEntry } from '../modelCatalog.js'
import { normalizeBaseUrl, providerApiBase, type ProviderProfile } from '../providers.js'

export const listModels = async (
  profile: ProviderProfile,
  signal?: AbortSignal
): Promise<ModelEntry[]> => {
  const base = profile.account ? providerApiBase(profile) : normalizeBaseUrl(profile.baseUrl)
  const response = await request(`${base}/models`, {
    headers: profile.account ? undefined : { Authorization: `Bearer ${profile.apiKey.trim()}` },
    signal,
  })
  const body: unknown = await response.json()
  if (!body || typeof body !== 'object' || !('data' in body) || !Array.isArray(body.data)) {
    throw new Error('接口未返回模型列表，可以手动填写模型 ID。')
  }
  const models = new Map<string, ModelEntry>()
  for (const entry of body.data as unknown[]) {
    if (!entry || typeof entry !== 'object' || !('id' in entry) || typeof entry.id !== 'string')
      continue
    const id = entry.id.trim()
    if (!id || id.length > 200 || models.has(id)) continue
    const name = 'name' in entry && typeof entry.name === 'string' ? entry.name.trim() : ''
    const contextWindow = 'context_window' in entry ? entry.context_window : undefined
    const maxOutputTokens = 'max_output_tokens' in entry ? entry.max_output_tokens : undefined
    const limits = {
      ...(isTokenCount(contextWindow) && { contextWindow }),
      ...(isTokenCount(maxOutputTokens) && { maxOutputTokens }),
    }
    models.set(id, {
      id,
      ...(name && name.length <= 200 && { name }),
      ...(Object.keys(limits).length > 0 && { limits }),
    })
  }
  return [...models.values()]
}
