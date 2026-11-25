import { abortTimeout } from '../utils/abort.js'
import { create } from 'zustand'
import { translate } from '../i18n/index.js'
import { flushWorkspaceChanges } from './workspace.js'
import {
  applyAccountProvider,
  beginProviderMove,
  getProvider,
  replaceAccountProviders,
  setProviderWorkspace,
  useProviders,
  type ProviderProfile,
  type ProviderProtocol,
} from './providers.js'

const base = '/api/account'
type AccountUser = { login: string; avatarUrl?: string | null }
type AccountMode = 'checking' | 'local' | 'account' | 'error'
type AccountEndpoint = { baseUrl: string; protocol: ProviderProtocol }
type RemoteProfile = Pick<
  ProviderProfile,
  | 'id'
  | 'name'
  | 'protocol'
  | 'baseUrl'
  | 'models'
  | 'modelNames'
  | 'modelParameters'
  | 'defaultModel'
  | 'scope'
>
type AccountSession = {
  available: boolean
  user: AccountUser | null
  workspace?: string | null
  migrateLegacyProviders?: boolean
  providers: RemoteProfile[]
  endpoints: AccountEndpoint[]
}

export const useAccount = create(() => ({
  mode: 'checking' as AccountMode,
  user: null as AccountUser | null,
  workspace: null as string | null,
  endpoints: [] as AccountEndpoint[],
}))

let sessionRequest = 0
export const loadAccount = async () => {
  const requestId = ++sessionRequest
  const setUnavailable = (mode: 'local' | 'error') => {
    if (requestId !== sessionRequest) return
    setProviderWorkspace(null)
    replaceAccountProviders([])
    useAccount.setState({ mode, user: null, workspace: null, endpoints: [] })
  }
  if (!['http:', 'https:'].includes(window.location.protocol)) {
    setUnavailable('local')
    return
  }
  try {
    const response = await fetch(base + '/session', {
      cache: 'no-store',
      signal: abortTimeout(8000),
    })
    const type = response.headers.get('content-type') ?? ''
    if (response.status === 404 || (response.ok && type.startsWith('text/html'))) {
      // A static-only release may return its index on unknown paths.
      setUnavailable(useAccount.getState().mode === 'account' ? 'error' : 'local')
      return
    }
    if (!response.ok || !type.startsWith('application/json'))
      throw new Error('Account service unavailable')
    const result: AccountSession = await response.json()
    if (result.available !== true) throw new Error('Invalid account response')
    if (requestId !== sessionRequest) return
    const workspace = result.user && typeof result.workspace === 'string' && /^[a-f0-9]{64}$/.test(result.workspace)
      ? result.workspace
      : null
    const previousWorkspace = useAccount.getState().workspace
    if (previousWorkspace && !workspace) {
      // Finish local writes while the signed-in workspace is still mounted.
      // The login redirect can otherwise leave a stored reply marked as streaming.
      await flushWorkspaceChanges().catch(() => {})
      if (requestId !== sessionRequest) return
    }
    if (previousWorkspace && workspace && workspace !== previousWorkspace) {
      window.location.reload()
      return
    }
    setProviderWorkspace(workspace, result.migrateLegacyProviders === true)
    replaceAccountProviders(
      result.providers.map((profile) => ({ ...profile, account: true, apiKey: '' }))
    )
    useAccount.setState({ mode: 'account', user: result.user, workspace, endpoints: result.endpoints })
  } catch {
    if (!useAccount.getState().user) setUnavailable('error')
  }
}

export const loginToAccount = () => window.location.assign(base + '/login')

const mutate = async (path: string, method: string, body?: object) => {
  const response = await fetch(base + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
    signal: abortTimeout(12000),
  })
  if (response.ok) return response
  const data = await response.json().catch(() => null)
  if (response.status === 401) {
    sessionRequest++
    replaceAccountProviders([])
    useAccount.setState({ user: null, workspace: null })
    throw new Error(translate('accountSignInRequired'))
  }
  const code = data?.error?.code
  throw new Error(
    translate(
      code === 'endpoint_not_allowed'
        ? 'accountEndpointNotAllowed'
        : code === 'key_required'
          ? 'accountKeyRequired'
          : 'accountRequestFailed'
    )
  )
}

export const saveAccountProvider = async (profile: ProviderProfile, creationId: string) => {
  const {
    id,
    account,
    name,
    protocol,
    baseUrl,
    models,
    modelNames,
    modelParameters,
    defaultModel,
    apiKey,
  } = profile
  const previous = getProvider(id)
  const move = !account && previous && !previous.account ? beginProviderMove(id) : null
  const body = {
    name,
    protocol,
    baseUrl,
    models,
    modelNames,
    modelParameters,
    defaultModel,
    apiKey: apiKey.trim() || undefined,
  }
  const path = (providerId: string) => '/providers/' + encodeURIComponent(providerId)
  const response = await mutate(account ? path(id) : '/providers', account ? 'PUT' : 'POST', {
    ...body,
    creationId: move?.creationId ?? creationId,
  })
  let result: RemoteProfile = await response.json()
  // A timed-out create may already have committed. Reuse its ID and apply the current edits.
  if (move?.retry) {
    result = await (await mutate(path(result.id), 'PUT', body)).json()
  }
  const saved: ProviderProfile = { ...result, account: true, apiKey: '' }
  sessionRequest++ // Ignore a session refresh started before this mutation committed.
  applyAccountProvider(saved, move ? id : undefined)
  return saved
}

export const removeAccountProvider = async (id: string) => {
  await mutate('/providers/' + encodeURIComponent(id), 'DELETE')
  sessionRequest++
  replaceAccountProviders(
    useProviders.getState().profiles.filter((profile) => profile.account && profile.id !== id)
  )
}

export const logoutFromAccount = async () => {
  await flushWorkspaceChanges()
  await mutate('/logout', 'POST')
  window.location.assign('/')
}
