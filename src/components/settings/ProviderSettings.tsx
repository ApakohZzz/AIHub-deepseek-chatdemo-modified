import { abortTimeout } from '../../utils/abort.js'
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { removeAccountProvider, saveAccountProvider, useAccount } from '../../services/account.js'
import { useSettings } from '../../services/settings.js'
import { workspaceStorageMode } from '../../services/workspace.js'
import {
  getProvider,
  getSelection,
  hasProviderKey,
  normalizeBaseUrl,
  providerPresets,
  removeProvider,
  saveProvider,
  selectModel,
  useProviders,
  type ProviderProfile,
  type ProviderProtocol,
} from '../../services/providers.js'
import { listModels } from '../../services/api/models.js'
import {
  applyModelChoices,
  getDefaultModel,
  getModelParameters,
  isTokenCount,
  resolveModelLimits,
  type ModelEntry,
  type ModelParameters,
} from '../../services/modelCatalog.js'
import { Button } from '../base/Button.js'
import fieldStyles from '../base/FormField.module.css'
import { Modal, ModalPresence } from '../base/Modal.js'
import { Select, type SelectOption } from '../base/Select.js'
import { showToast } from '../base/toastState.js'
import { ProviderIcon } from '../brand/ProviderIcon.js'
import { createCatalogRow, ModelCatalogEditor } from './ModelCatalogEditor.js'
import { ModelDiscoveryDialog } from './ModelDiscoveryDialog.js'
import { SettingCell } from './SettingCell.js'
import styles from './ProviderSettings.module.css'
import settingsStyles from './Settings.module.css'

const providerOptions: SelectOption<ProviderProtocol>[] = Object.values(providerPresets).map(
  (provider) => ({
    value: provider.protocol,
    label: provider.name,
    icon: <ProviderIcon provider={provider} />,
  })
)

const protocolOptions: SelectOption<ProviderProtocol>[] = [
  { value: 'deepseek', label: 'DeepSeek Messages + Files' },
  { value: 'openai', label: 'OpenAI Chat Completions' },
]

export const ProviderSettings = () => {
  const profiles = useProviders((state) => state.profiles)
  const t = useTranslate()
  const user = useAccount((state) => state.user)
  const locale = useSettings((state) => state.locale)
  const en = locale === 'en-US'
  const [adding, setAdding] = useState<ProviderProfile | null>(null)
  const [deleting, setDeleting] = useState<ProviderProfile | null>(null)
  const [preset, setPreset] = useState<ProviderProtocol>('deepseek')
  const [removing, setRemoving] = useState(false)
  const addingId = useId()

  return (
    <>
      <SettingCell
        className={styles.addProvider}
        label={t('providerAdd')}
        description={t(user ? 'accountDescription' : 'providerLocalDescription')}
        action={
          <div className={styles.actions}>
            <Select
              ariaLabel={t('providerTemplate')}
              className={styles.addSelect}
              value={preset}
              options={providerOptions}
              onChange={setPreset}
            />
            <Button
              variant="outlined"
              size="m"
              className={settingsStyles.cellButton}
              aria-label={t('providerAdd')}
              aria-expanded={Boolean(adding)}
              aria-controls={adding ? addingId : undefined}
              onClick={() =>
                setAdding((current) => {
                  if (current) return null
                  return {
                    ...providerPresets[preset],
                    models: [...providerPresets[preset].models],
                    id: crypto.randomUUID(),
                    scope: crypto.randomUUID(),
                    apiKey: '',
                  }
                })
              }
            >
              {t(adding ? 'providerCollapse' : 'providerAddAction')}
            </Button>
          </div>
        }
      />
      {adding && (
        <div id={addingId} className={styles.profileGroup}>
          <ProviderEditor
            key={adding.id}
            initial={adding}
            onClose={() => setAdding((current) => (current?.id === adding.id ? null : current))}
          />
        </div>
      )}
      {profiles.map((profile) => (
        <ProviderRow key={profile.id} profile={profile} onRemove={() => setDeleting(profile)} />
      ))}
      <ModalPresence>
        {deleting ? (
          <Modal
            title={en ? 'Remove provider' : '移除供应商'}
            onClose={() => {
              if (!removing) setDeleting(null)
            }}
            footer={
              <>
                <Button variant="outlined" disabled={removing} onClick={() => setDeleting(null)}>
                  {en ? 'Cancel' : '取消'}
                </Button>
                <Button
                  variant="danger"
                  disabled={removing}
                  onClick={async () => {
                    setRemoving(true)
                    try {
                      if (deleting.account) await removeAccountProvider(deleting.id)
                      else removeProvider(deleting.id)
                      setDeleting(null)
                    } catch (error) {
                      showToast(error instanceof Error ? error.message : t('accountRequestFailed'))
                    } finally {
                      setRemoving(false)
                    }
                  }}
                >
                  {en ? 'Remove' : '移除'}
                </Button>
              </>
            }
          >
            {en
              ? `Remove ${deleting.name} ${deleting.account ? 'from your account' : 'from this browser'}? Existing chats will keep their history and can select another provider.`
              : `移除 ${deleting.name} 的${deleting.account ? '账号' : '本地'}配置？已有聊天记录保留，可重新选择供应商。`}
          </Modal>
        ) : null}
      </ModalPresence>
    </>
  )
}

const ProviderRow = ({ profile, onRemove }: { profile: ProviderProfile; onRemove: () => void }) => {
  const t = useTranslate()
  const id = useId()
  const [editor, setEditor] = useState<'closed' | 'expanded' | 'collapsed'>('closed')
  const expanded = editor === 'expanded'
  const [probe, setProbe] = useState<{ profile: ProviderProfile; models: ModelEntry[] | null }>()
  const hasKey = hasProviderKey(profile)
  const result = probe?.profile === profile ? probe.models : undefined
  const status = Array.isArray(result)
    ? 'connected'
    : hasKey && result === undefined
      ? 'checking'
      : 'unreachable'
  const statusLabel = t(
    status === 'connected'
      ? 'providerConnected'
      : status === 'checking'
        ? 'providerConnectionChecking'
        : 'providerUnreachable'
  )
  useEffect(() => {
    if (!hasKey) {
      return
    }
    const controller = new AbortController()
    const signal = abortTimeout(8000, controller.signal)
    const settle = (models: ModelEntry[] | null) => {
      if (!controller.signal.aborted) {
        setProbe({ profile, models })
      }
    }
    void listModels(profile, signal).then(settle, () => settle(null))
    return () => controller.abort()
  }, [hasKey, profile])
  return (
    <section className={styles.profileGroup} aria-label={profile.name}>
      <SettingCell
        className={styles.profile}
        label={
          <span className={styles.profileLabel}>
            <ProviderIcon provider={profile} />
            <bdi>{profile.name}</bdi>
          </span>
        }
        description={
          <span className={styles.profileSummary}>
            <span
              className={styles.connection}
              data-connection={status}
              role="img"
              aria-label={statusLabel}
              title={statusLabel}
            />
            <span>
              {t(profile.models.length === 1 ? 'providerOneModel' : 'providerModelCount', {
                count: profile.models.length,
              })}
              {' · '}
              {t(profile.account ? 'providerAccountSync' : 'providerBrowserOnly')}
            </span>
          </span>
        }
        action={
          <div className={styles.actions}>
            <Button
              variant="outlined"
              size="m"
              className={settingsStyles.cellButton}
              aria-label={t(expanded ? 'providerCollapseNamed' : 'providerEditNamed', {
                name: profile.name,
              })}
              aria-expanded={expanded}
              aria-controls={editor !== 'closed' ? id : undefined}
              onClick={() => setEditor(expanded ? 'collapsed' : 'expanded')}
            >
              {t(expanded ? 'providerCollapse' : 'providerEdit')}
            </Button>
            <Button
              variant="text"
              size="m"
              className={settingsStyles.cellButton}
              aria-label={t('providerRemoveNamed', { name: profile.name })}
              onClick={onRemove}
            >
              {t('providerRemove')}
            </Button>
          </div>
        }
      />
      {editor !== 'closed' && (
        <div id={id} hidden={!expanded}>
          <ProviderEditor
            initial={profile}
            availableModels={result ?? undefined}
            onClose={() => setEditor('closed')}
          />
        </div>
      )}
    </section>
  )
}

const ProviderEditor = ({
  initial,
  onClose,
  availableModels,
}: {
  initial: ProviderProfile
  onClose: () => void
  availableModels?: ModelEntry[]
}) => {
  const en = useSettings((state) => state.locale === 'en-US')
  const t = useTranslate()
  const user = useAccount((state) => state.user)
  const endpoints = useAccount((state) => state.endpoints)
  const workspace = useAccount((state) => state.workspace)
  const id = useId()
  const protocolLabel = en ? 'API protocol' : '接口协议'
  const [profile, setProfile] = useState(initial)
  const [rows, setRows] = useState(() =>
    initial.models.map((id) => {
      const name = initial.modelNames?.[id]
      return createCatalogRow(
        { id, name: typeof name === 'string' ? name : undefined },
        getModelParameters(initial, id)
      )
    })
  )
  const [defaultModel, setDefaultModel] = useState(initial.defaultModel ?? '')
  const [discovery, setDiscovery] = useState(false)
  const [saving, setSaving] = useState(false)
  const [sync, setSync] = useState(() => Boolean(
    initial.account || (workspace && workspaceStorageMode(workspace) === 'account' && !getProvider(initial.id))
  ))
  const [notice, setNotice] = useState('')
  const [discovered, setDiscovered] = useState<{
    connection: ProviderProfile
    models: ModelEntry[]
  }>()
  const sameConnection = (connection: ProviderProfile) =>
    profile.baseUrl === connection.baseUrl &&
    profile.protocol === connection.protocol &&
    profile.apiKey === connection.apiKey
  const reportedModels =
    discovered && sameConnection(discovered.connection)
      ? discovered.models
      : sameConnection(initial)
        ? availableModels
        : undefined
  const reportedLimits = new Map(reportedModels?.map(({ id, limits }) => [id, limits]))
  const limitsFor = (model: string) =>
    resolveModelLimits(
      profile.baseUrl.trim().replace(/\/+$/, ''),
      profile.protocol,
      model,
      reportedLimits.get(model)
    )
  const canFetchAccountModels =
    initial.account &&
    !profile.apiKey &&
    profile.baseUrl === initial.baseUrl &&
    profile.protocol === initial.protocol
  const fetchHint = sync && !canFetchAccountModels ? id + '-fetch-hint' : undefined
  const submitting = useRef(false)
  const update = (change: Partial<ProviderProfile>) => {
    setNotice('')
    setProfile((current) => ({ ...current, ...change }))
  }

  return (
    <form
      className={styles.editor}
      onSubmit={async (event) => {
        event.preventDefault()
        if (submitting.current || discovery) return
        submitting.current = true
        setSaving(true)
        setNotice('')
        try {
          const models = rows.map((row) => row.id.trim())
          if (models.some((model) => !model) || (!models.length && !defaultModel.trim()))
            throw new Error(t('catalogNeedsModel'))
          if (new Set(models).size !== models.length) throw new Error(t('catalogDuplicateModel'))
          if (models.length > 512) throw new Error(t('catalogTooManyModels'))
          const modelParameters: [string, ModelParameters][] = []
          for (const row of rows) {
            const model = row.id.trim()
            const parameters: ModelParameters = {}
            for (const field of ['contextWindow', 'maxOutputTokens'] as const) {
              const value = row[field].trim()
              if (!value) {
                continue
              }
              const count = Number(value)
              if (!/^\d+$/.test(value) || !isTokenCount(count)) {
                throw new Error(t('catalogInvalidTokens', { model }))
              }
              parameters[field] = count
            }
            const limits = limitsFor(model)
            const output = parameters.maxOutputTokens
            if (
              output !== undefined &&
              output >
                Math.min(
                  parameters.contextWindow ?? Infinity,
                  limits.contextWindow ?? Infinity,
                  limits.maxOutputTokens ?? Infinity
                )
            ) {
              throw new Error(t('catalogOutputExceedsLimit', { model }))
            }
            if (parameters.contextWindow !== undefined || output !== undefined) {
              modelParameters.push([model, parameters])
            }
          }
          const input = {
            ...profile,
            baseUrl: normalizeBaseUrl(profile.baseUrl),
            models,
            modelNames: Object.fromEntries(
              rows.filter((row) => row.name.trim()).map((row) => [row.id.trim(), row.name.trim()])
            ),
            modelParameters: Object.fromEntries(modelParameters),
            defaultModel: defaultModel.trim(),
          }
          if (
            sync &&
            !endpoints.some(
              (endpoint) =>
                endpoint.baseUrl === input.baseUrl && endpoint.protocol === input.protocol
            )
          )
            throw new Error(t('accountEndpointNotAllowed'))
          const creating = !getProvider(initial.id)
          const next = sync ? await saveAccountProvider(input, initial.id) : saveProvider(input)
          if (
            hasProviderKey(next) &&
            (creating || !hasProviderKey(getProvider(getSelection().providerId)))
          ) {
            selectModel({ providerId: next.id, model: getDefaultModel(next) })
          }
          onClose()
        } catch (error) {
          setNotice(error instanceof Error ? error.message : String(error))
        } finally {
          submitting.current = false
          setSaving(false)
        }
      }}
    >
      <SettingCell
        className={styles.field}
        label={<label htmlFor={id + '-name'}>{en ? 'Provider name' : '供应商名称'}</label>}
        action={
          <input
            id={id + '-name'}
            className={`${fieldStyles.field} ${styles.control}`}
            required
            value={profile.name}
            onChange={(event) => update({ name: event.target.value })}
          />
        }
      />
      <SettingCell
        className={styles.field}
        label={protocolLabel}
        action={
          <Select
            ariaLabel={protocolLabel}
            className={styles.control}
            value={profile.protocol}
            options={protocolOptions}
            onChange={(protocol) => update({ protocol })}
          />
        }
      />
      <SettingCell
        className={styles.field}
        label={<label htmlFor={id + '-url'}>{en ? 'API Base URL' : 'API 地址'}</label>}
        action={
          <input
            id={id + '-url'}
            className={`${fieldStyles.field} ${styles.control}`}
            required
            type="url"
            placeholder="https://api.example.com/v1"
            value={profile.baseUrl}
            onChange={(event) => update({ baseUrl: event.target.value })}
          />
        }
      />
      <SettingCell
        className={styles.field}
        label={<label htmlFor={id + '-key'}>API Key</label>}
        action={
          <input
            id={id + '-key'}
            className={`${fieldStyles.field} ${styles.control}`}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={profile.apiKey}
            placeholder={
              initial.account
                ? t('accountKeySaved')
                : en
                  ? 'Enter your own API Key'
                  : '填写自己的 API Key'
            }
            onChange={(event) => update({ apiKey: event.target.value })}
          />
        }
      />
      {(user || initial.account) && (
        <SettingCell
          className={styles.field}
          label={t('accountStorage')}
          action={
            <Select
              ariaLabel={t('accountStorage')}
              className={styles.control}
              value={sync ? 'account' : 'local'}
              disabled={Boolean(initial.account) || saving}
              options={[
                { value: 'local', label: t('accountStorageLocal') },
                { value: 'account', label: t('accountStorageSynced') },
              ]}
              onChange={(value) => {
                setSync(value === 'account')
                setNotice('')
              }}
            />
          }
        />
      )}
      <SettingCell
        className={styles.field}
        label={<label htmlFor={id + '-default-model'}>{t('catalogDefaultModel')}</label>}
        action={
          <input
            id={id + '-default-model'}
            className={`${fieldStyles.field} ${styles.control}`}
            value={defaultModel}
            placeholder={t('catalogDefaultPlaceholder')}
            maxLength={200}
            disabled={saving}
            onChange={(event) => setDefaultModel(event.target.value)}
          />
        }
      />
      <ModelCatalogEditor
        rows={rows}
        setRows={setRows}
        disabled={saving}
        fetchDisabled={
          saving ||
          (sync ? !canFetchAccountModels : !profile.apiKey.trim() || !profile.baseUrl.trim())
        }
        fetchHint={fetchHint}
        limitsFor={limitsFor}
        onFetch={() => {
          setNotice('')
          setDiscovery(true)
        }}
      />
      {notice && (
        <p role="status" className={styles.notice}>
          {notice}
        </p>
      )}
      {fetchHint && (
        <p className={styles.description} id={fetchHint}>
          {t('accountSaveBeforeModels')}
        </p>
      )}
      <div className={styles.editorFooter}>
        <div className={styles.actions}>
          <Button variant="outlined" size="m" disabled={saving} onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" size="m" disabled={saving}>
            {en ? 'Save' : '保存'}
          </Button>
        </div>
      </div>
      <ModalPresence>
        {discovery ? (
          <ModelDiscoveryDialog
            provider={profile}
            existing={rows}
            onClose={() => setDiscovery(false)}
            onApply={(found, selected) => {
              setDiscovered({ connection: profile, models: found })
              const next = applyModelChoices(rows, found, selected, createCatalogRow)
              if (next.length > 512) setNotice(t('catalogTooManyModels'))
              else setRows(next)
              setDiscovery(false)
            }}
          />
        ) : null}
      </ModalPresence>
    </form>
  )
}
