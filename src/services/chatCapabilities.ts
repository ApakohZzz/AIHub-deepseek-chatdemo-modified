import type { ProviderProfile } from './providers.js'

const lowEffortModels = new Set(['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.2-sol', 'gpt-6.2-astra'])
const searchModels = new Set([...lowEffortModels, 'gpt-4.1', 'gpt-4.1-2025-04-14'])

export const getChatCapabilities = (profile: ProviderProfile | undefined, model: string) => {
  const deepseek = profile?.protocol === 'deepseek'
  const officialOpenAI =
    profile?.protocol === 'openai' && profile.baseUrl === 'https://api.openai.com/v1'
  const adjustableEffort = officialOpenAI && lowEffortModels.has(model)
  return {
    adjustableEffort,
    thinking: deepseek || adjustableEffort,
    search: deepseek || (officialOpenAI && searchModels.has(model)),
  }
}
