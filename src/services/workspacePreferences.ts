import { loadWorkspaceValues, saveWorkspaceValue } from './chat/db.js'
import { normalizeLocation } from './location.js'
import { getProvider, selectModel, useProviders } from './providers.js'
import { useSettings } from './settings.js'

const preferences = [
  'locale',
  'themePreference',
  'location',
  'ttsVoice',
  'thinking',
  'search',
  'siderCollapsed',
] as const
type Preference = (typeof preferences)[number]
type AccountSettings = Pick<ReturnType<typeof useSettings.getState>, Preference>

const restoredPreference = (settings: Partial<AccountSettings>, id: string, value: unknown) => {
  switch (id) {
    case 'locale':
      if (value === 'zh-CN' || value === 'en-US') settings.locale = value
      break
    case 'themePreference':
      if (value === 'light' || value === 'dark' || value === 'system')
        settings.themePreference = value
      break
    case 'location':
      if (value === null) settings.location = null
      else {
        const location = normalizeLocation(value)
        if (location) settings.location = location
      }
      break
    case 'ttsVoice':
      if (value === 'stella' || value === 'tide') settings.ttsVoice = value
      break
    case 'thinking':
    case 'search':
    case 'siderCollapsed':
      if (typeof value === 'boolean') settings[id] = value
      break
  }
}

export const bindWorkspacePreferences = (workspace: string, onError: () => void) => {
  let applying = false
  let stopped = false
  const writes = new Map<string, Promise<void>>()
  const save = (id: string, value: unknown) => {
    const previous = writes.get(id) ?? Promise.resolve()
    const write = previous
      .catch(() => {})
      .then(() => saveWorkspaceValue(workspace, 'settings', id, { value }))
    writes.set(id, write)
    void write.then(
      () => {
        if (writes.get(id) === write) writes.delete(id)
      },
      () => onError()
    )
  }
  const stopSettings = useSettings.subscribe((settings, previous) => {
    if (applying) return
    for (const id of preferences) {
      if (settings[id] !== previous[id]) save(id, settings[id])
    }
  })
  const stopProviders = useProviders.subscribe(({ selection }, previous) => {
    if (applying || !getProvider(selection.providerId)?.account) return
    if (
      selection.providerId !== previous.selection.providerId ||
      selection.model !== previous.selection.model
    )
      save('modelSelection', selection)
  })
  return {
    async restore() {
      const capturedSettings = useSettings.getState()
      const capturedSelection = useProviders.getState().selection
      const records = await loadWorkspaceValues(workspace, 'settings')
      if (stopped) return
      const current = useSettings.getState()
      const next: Partial<AccountSettings> = {}
      applying = true
      try {
        for (const {
          id,
          value: { value },
        } of records) {
          if (writes.has(id)) continue
          if (
            id === 'modelSelection' &&
            value &&
            typeof value === 'object' &&
            useProviders.getState().selection === capturedSelection
          ) {
            const { providerId, model } = value as Record<string, unknown>
            if (
              typeof providerId === 'string' &&
              typeof model === 'string' &&
              getProvider(providerId)?.account
            )
              selectModel({ providerId, model }, false)
          } else if (
            preferences.some((key) => key === id && current[key] === capturedSettings[key])
          ) {
            restoredPreference(next, id, value)
          }
        }
        if (Object.keys(next).length) useSettings.setState(next)
      } finally {
        applying = false
      }
    },
    async flush() {
      await Promise.all(writes.values())
    },
    stop() {
      stopped = true
      stopSettings()
      stopProviders()
    },
  }
}
