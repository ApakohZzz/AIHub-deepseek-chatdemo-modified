import clsx from 'clsx'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import giteaLogo from '../../assets/gitea-logo.svg'
import {
  IconCubeOutline16,
  IconDarkOutline16,
  IconDataOutline16,
  IconDownloadOutline16,
  IconFollowsystemOutline16,
  IconLightOutline16,
  IconLoadingOutline16,
  IconSettingsOutline16,
  IconUploadOutline14,
  IconUserOutline16,
} from '../base/icons.js'
import { logoutFromAccount, useAccount } from '../../services/account.js'
import { flushWorkspaceChanges, selectWorkspaceStorage, useWorkspaceSync, workspaceStorageMode } from '../../services/workspace.js'
import {
  BackupError,
  clearHistory,
  exportHistory,
  importHistory,
} from '../../services/chat/backup.js'
import { newChat, refreshSyncedSessions, useChatStore } from '../../services/chat/store.js'
import { localAccountStorage } from '../../services/chat/db.js'
import { recoverWorkspaceDraft, useDraftRecovery } from '../../services/chat/drafts.js'
import { countMergeSources, mergeWorkspaceHistory } from '../../services/workspaceMigration.js'
import { regionCodes, getRegionName, provinces } from '../../services/location.js'
import {
  isChineseBrowser,
  setLocale,
  setLocation,
  setThemePreference,
  setTtsVoice,
  useSettings,
  type ThemePreference,
} from '../../services/settings.js'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { Modal, ModalPresence } from '../base/Modal.js'
import { Select } from '../base/Select.js'
import { showToast } from '../base/toastState.js'
import { ProviderSettings } from './ProviderSettings.js'
import { SettingCell, type SettingStatus as Status } from './SettingCell.js'
import { closeSettings, useSettingsDialog, type SettingsSection } from './settingsDialogState.js'
import styles from './Settings.module.css'

/**
 * 设置弹窗：模型供应商、通用设置、账户管理与数据管理。
 * 桌面端为居中弹窗、左侧导航；移动端为底部弹层、导航横排在内容上方
 */
export const SettingsDialog = () => {
  const opening = useSettingsDialog((state) => (state.open ? state.opening : null))
  const historyImport = useHistoryImport()
  return (
    <ModalPresence>
      {opening !== null ? <SettingsContent key={opening} historyImport={historyImport} /> : null}
    </ModalPresence>
  )
}

const sections: { value: SettingsSection; label: TranslationKey; icon: ReactNode }[] = [
  { value: 'providers', label: 'providers', icon: <IconCubeOutline16 /> },
  {
    value: 'general',
    label: 'settingDialogAsideGeneralOptionLabel',
    icon: <IconSettingsOutline16 />,
  },
  { value: 'account', label: 'accountManagement', icon: <IconUserOutline16 /> },
  { value: 'data', label: 'settingDialogAsideDataOptionLabel', icon: <IconDataOutline16 /> },
]

const SettingsContent = ({ historyImport }: { historyImport: ReturnType<typeof useHistoryImport> }) => {
  const t = useTranslate()
  const siteVersion = document.querySelector<HTMLMetaElement>('meta[name="application-version"]')?.content
  const user = useAccount((state) => state.user)
  const workspace = useAccount((state) => state.workspace)
  const hydrated = useWorkspaceSync((state) => state.hydrated)
  // 打开时按调用方指定的分组选中，之后在弹窗内切换
  const [section, setSection] = useState(() => useSettingsDialog.getState().section)
  const historyDelete = useHistoryDelete()
  const replacingHistory = useChatStore((state) => state.importingHistory)
  const historyBusy = historyImport.busy || historyDelete.busy || replacingHistory
  const historyLoading = workspace && workspaceStorageMode(workspace) === 'account' && !hydrated
  return (
    <>
      <Modal
        title={t('settings')}
        closable
        className={styles.dialog}
        mainClassName={styles.dialogMain}
        onClose={() => {
          if (!historyDelete.busy) {
            historyImport.dismiss()
            closeSettings()
          }
        }}
      >
        <div role="tablist" className={styles.navigation}>
          {sections
            .filter((item) => item.value !== 'account' || user)
            .map((item) => (
              <button
                key={item.value}
                type="button"
                role="tab"
                aria-selected={section === item.value}
                className={clsx(styles.navItem, section === item.value && styles.navItemActive)}
                onClick={() => setSection(item.value)}
              >
                {item.icon}
                {t(item.label)}
              </button>
            ))}
        </div>
        <div role="tabpanel" className={styles.content}>
          {section === 'providers' ? (
            <ProviderSettings />
          ) : section === 'account' && user ? (
            <AccountSettings login={user.login} />
          ) : section === 'general' ? (
            <>
              <ThemeSetting />
              <LocaleSetting />
              <TtsVoiceSetting />
              <LocationSetting />
              {siteVersion && (
                <SettingCell
                  label={t('settingsSiteVersion')}
                  status={null}
                  action={<span className={styles.description}>v{siteVersion}</span>}
                />
              )}
            </>
          ) : (
            <>
              {workspace && <WorkspaceStorage workspace={workspace} disabled={historyBusy} />}
              <ImportHistory historyImport={historyImport} disabled={historyBusy || Boolean(historyLoading)} />
              <ExportHistory disabled={historyBusy || Boolean(historyLoading)} />
              <SettingCell
                label={t('deleteAllSessions')}
                status={null}
                action={
                  <Button
                    variant="dangerOutlined"
                    size="m"
                    className={styles.cellButton}
                    disabled={historyBusy || Boolean(historyLoading)}
                    onClick={historyDelete.open}
                  >
                    {t('delete')}
                  </Button>
                }
              />
            </>
          )}
        </div>
      </Modal>
      <ModalPresence>
        {historyImport.file ? <ImportConfirm historyImport={historyImport} /> : null}
      </ModalPresence>
      <ModalPresence>
        {historyDelete.opened ? <DeleteAllConfirm historyDelete={historyDelete} /> : null}
      </ModalPresence>
    </>
  )
}

const WorkspaceStorage = ({ workspace, disabled }: { workspace: string; disabled: boolean }) => {
  const t = useTranslate()
  const status = useWorkspaceSync((state) => state.status)
  const [switching, setSwitching] = useState(false)
  const [merging, setMerging] = useState(false)
  const [legacyCount, setLegacyCount] = useState(0)
  const mode = workspaceStorageMode(workspace)
  const browserStorage = localAccountStorage(workspace)
  const storage = mode === 'account' ? workspace : browserStorage
  const otherStorage = mode === 'account' ? browserStorage : workspace
  useEffect(() => {
    let current = true
    void countMergeSources([null, otherStorage]).then((count) => {
      if (current) setLegacyCount(count)
    }, () => {})
    return () => { current = false }
  }, [otherStorage])
  const description = {
    local: 'workspaceLocalDescription',
    syncing: 'workspaceSyncing',
    synced: 'workspaceSynced',
    offline: 'workspaceOffline',
    error: 'workspaceSyncError',
    limit: 'workspaceSyncLimit',
  } satisfies Record<typeof status, TranslationKey>
  const onChange = async (value: 'account' | 'local') => {
    if (value === mode || switching || merging) return
    setSwitching(true)
    try {
      await flushWorkspaceChanges()
      selectWorkspaceStorage(workspace, value)
      window.location.reload()
    } catch {
      setSwitching(false)
      showToast({ key: 'workspaceSaveFailed', type: 'error' })
    }
  }
  const merge = async () => {
    setMerging(true)
    try {
      const copyTitle = (title: string) => t('workspaceConflictTitle', { title: title || t('untitledChat') })
      let count = await mergeWorkspaceHistory(null, storage, copyTitle)
      count += await mergeWorkspaceHistory(otherStorage, storage, copyTitle)
      await refreshSyncedSessions()
      showToast({ key: 'workspaceMergeComplete', params: { count } })
    } catch {
      showToast({ key: 'workspaceMergeFailed', type: 'error' })
    } finally {
      setMerging(false)
    }
  }
  return (
    <>
      <SettingCell
        label={t('workspaceStorage')}
        description={<span role="status">{t(description[status])}</span>}
        action={
          <Select
            ariaLabel={t('workspaceStorage')}
            value={mode}
            disabled={disabled || switching || merging}
            options={[
              { value: 'account', label: t('workspaceAccountMode') },
              { value: 'local', label: t('workspaceLocalMode') },
            ]}
            onChange={(value) => void onChange(value)}
          />
        }
      />
      {legacyCount > 0 && (
        <SettingCell
          label={t(mode === 'account' ? 'workspaceMergeLegacy' : 'workspaceCopyToBrowser')}
          description={t('workspaceLegacyCount', { count: legacyCount })}
          action={
            <Button variant="outlined" size="m" className={styles.cellButton} disabled={disabled || merging || switching} onClick={() => void merge()}>
              {t(merging ? 'workspaceMerging' : 'workspaceMerge')}
            </Button>
          }
        />
      )}
      <WorkspaceDraftCopies storage={storage} disabled={disabled || merging || switching} />
    </>
  )
}

const WorkspaceDraftCopies = ({ storage, disabled }: { storage: string; disabled: boolean }) => {
  const t = useTranslate()
  const copies = useDraftRecovery((state) => state.copies)
  const [recovering, setRecovering] = useState<string | null>(null)
  const recover = async (id: string) => {
    setRecovering(id)
    try {
      await recoverWorkspaceDraft(storage, id)
      newChat()
      closeSettings()
    } catch {
      showToast({ key: 'workspaceDraftRecoverFailed', type: 'error' })
    } finally {
      setRecovering(null)
    }
  }
  return copies.map(({ id, text, attachmentCount }) => (
    <SettingCell
      key={id}
      label={t('workspaceDraftCopy')}
      description={text ? text.trim().slice(0, 75) : t('workspaceDraftAttachments', { count: attachmentCount })}
      action={
        <Button variant="outlined" size="m" className={styles.cellButton} disabled={disabled || recovering !== null} onClick={() => void recover(id)}>
          {t('workspaceRecoverDraft')}
        </Button>
      }
    />
  ))
}

const AccountSettings = ({ login }: { login: string }) => {
  const t = useTranslate()
  const [signingOut, setSigningOut] = useState(false)
  return (
    <>
      <SettingCell
        label={t('accountUsername')}
        action={
          <div className={styles.accountValue}>
            <bdi>{login}</bdi>
            <img alt="Gitea" title={t('accountGiteaLogin')} src={giteaLogo} width="18" height="18" />
          </div>
        }
      />
      <SettingCell
        label={t('accountCurrentSession')}
        action={
          <Button
            variant="dangerOutlined"
            size="m"
            className={styles.cellButton}
            disabled={signingOut}
            onClick={async () => {
              setSigningOut(true)
              try {
                await logoutFromAccount()
              } catch {
                showToast({ key: 'accountRequestFailed', type: 'error' })
                setSigningOut(false)
              }
            }}
          >
            {t('accountSignOut')}
          </Button>
        }
      />
    </>
  )
}

/** 删除确认保留在设置之上；失败可重试，成功只关闭确认弹窗。 */
const DeleteAllConfirm = ({
  historyDelete,
}: {
  historyDelete: ReturnType<typeof useHistoryDelete>
}) => {
  const t = useTranslate()
  return (
    <Modal
      title={t('deleteAllSessionsModalTitle')}
      className={styles.deleteConfirm}
      onClose={historyDelete.cancel}
      footer={
        <div className={styles.deleteActions} aria-busy={historyDelete.busy}>
          <Button
            variant="outlined"
            autoFocus
            disabled={historyDelete.busy}
            onClick={historyDelete.cancel}
          >
            {t('cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={historyDelete.busy}
            onClick={() => void historyDelete.confirm()}
          >
            {t(historyDelete.busy ? 'historyDeleting' : 'deleteAllSessions')}
          </Button>
        </div>
      }
    >
      {t('deleteAllSessionsModalDescription')}
    </Modal>
  )
}

const useHistoryDelete = () => {
  const [opened, setOpened] = useState(false)
  const [busy, setBusy] = useState(false)
  const deleting = useRef(false)

  const confirm = async () => {
    if (deleting.current) {
      return
    }
    deleting.current = true
    setBusy(true)
    try {
      await clearHistory()
      setOpened(false)
      showToast({ key: 'historyDeleted' })
    } catch {
      showToast({ key: 'historyDeleteFailed', type: 'error' })
    } finally {
      deleting.current = false
      setBusy(false)
    }
  }

  return {
    opened,
    busy,
    open: () => setOpened(true),
    cancel: () => {
      if (!deleting.current) {
        setOpened(false)
      }
    },
    confirm,
  }
}

const LocationSetting = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const location = useSettings((state) => state.location)
  const province =
    location?.region === 'CN'
      ? provinces.find((item) => item.code === location.province)
      : undefined

  return (
    <SettingCell
      label={t('settingsLocation')}
      status={null}
      className={styles.locationCell}
      action={
        <div className={styles.locationSelectors}>
          {isChineseBrowser() ? (
            <>
              <Select
                ariaLabel={t('settingsLocationProvince')}
                className={styles.provinceSelect}
                value={province?.code ?? ''}
                placeholder={t('settingsLocationProvince')}
                options={provinces.map((item) => ({ value: item.code, label: item.name }))}
                onChange={(value) => {
                  if (value !== province?.code) {
                    setLocation({ region: 'CN', province: value })
                  }
                }}
              />
              <Select
                ariaLabel={t('settingsLocationCity')}
                className={styles.citySelect}
                value={province ? (location?.city ?? '') : ''}
                disabled={!province?.cities.length}
                placeholder={t('settingsLocationCity')}
                options={
                  province?.cities.map((item) => ({ value: item.code, label: item.name })) ?? []
                }
                onChange={(value) => {
                  if (province) {
                    setLocation({ region: 'CN', province: province.code, city: value })
                  }
                }}
              />
            </>
          ) : (
            <Select
              ariaLabel={t('settingsLocationRegion')}
              className={styles.regionSelect}
              value={location?.region ?? ''}
              placeholder={t('settingsLocationRegion')}
              options={regionCodes
                .map((code) => ({ value: code, label: getRegionName(code, locale) }))
                .sort((a, b) => a.label.localeCompare(b.label, locale))}
              onChange={(value) => setLocation({ region: value })}
            />
          )}
        </div>
      }
    />
  )
}

const LocaleSetting = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  return (
    <SettingCell
      label={t('settingsLocalePreference')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsLocalePreference')}
          value={locale}
          options={[
            { value: 'zh-CN', label: t('settingsLocaleZhCN'), lang: 'zh-CN' },
            { value: 'en-US', label: t('settingsLocaleEnUS'), lang: 'en' },
          ]}
          onChange={setLocale}
        />
      }
    />
  )
}

/** 朗读音色：stella（海星，女声）/ tide（暗潮，男声） */
const TtsVoiceSetting = () => {
  const t = useTranslate()
  const ttsVoice = useSettings((state) => state.ttsVoice)
  return (
    <SettingCell
      label={t('settingsTtsVoice')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsTtsVoice')}
          value={ttsVoice}
          options={[
            { value: 'stella', label: t('settingsTtsVoiceStella') },
            { value: 'tide', label: t('settingsTtsVoiceTide') },
          ]}
          onChange={setTtsVoice}
        />
      }
    />
  )
}

/** 覆盖导入的二次确认，叠在设置弹窗上 */
const ImportConfirm = ({
  historyImport,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
}) => {
  const t = useTranslate()
  return (
    <Modal
      title={t('historyImportConfirmTitle')}
      className={styles.importConfirm}
      onClose={historyImport.cancel}
      footer={
        <>
          <Button variant="outlined" size="m" autoFocus onClick={historyImport.cancel}>
            {t('cancel')}
          </Button>
          <Button variant="dangerOutlined" size="m" onClick={() => void historyImport.confirm()}>
            {t('historyImportConfirm')}
          </Button>
        </>
      }
    >
      <div className={styles.importConfirmText}>{t('historyImportConfirmDescription')}</div>
    </Modal>
  )
}

const themeOptions: { value: ThemePreference; label: TranslationKey; icon: ReactNode }[] = [
  {
    value: 'light',
    label: 'avatarMenuSettingsDialogThemeSelectLightOption',
    icon: <IconLightOutline16 />,
  },
  {
    value: 'dark',
    label: 'avatarMenuSettingsDialogThemeSelectDarkOption',
    icon: <IconDarkOutline16 />,
  },
  {
    value: 'system',
    label: 'avatarMenuSettingsDialogThemeSelectSystemOption',
    icon: <IconFollowsystemOutline16 />,
  },
]

/**
 * 主题项：标题下方浅色 / 深色 / 跟随系统三个选块。
 * 与下方语言选项连续排列。
 */
const ThemeSetting = () => {
  const t = useTranslate()
  const themePreference = useSettings((state) => state.themePreference)
  const label = t('avatarMenuSettingsDialogThemeItemLabel')
  return (
    <div className={styles.theme}>
      {label}
      <div role="radiogroup" aria-label={label} className={styles.themeOptions}>
        {themeOptions.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={themePreference === option.value}
            className={clsx(
              styles.themeOption,
              themePreference === option.value && styles.themeOptionSelected
            )}
            onClick={() => setThemePreference(option.value)}
          >
            {option.icon}
            {t(option.label)}
          </button>
        ))}
      </div>
    </div>
  )
}

/** 导出失败附带原因：预期的错误用对应文案作原因，其他错误用错误信息。 */
const errorStatus = (key: TranslationKey, error: unknown): Status => ({
  key,
  ...(error instanceof BackupError
    ? { reason: error.key }
    : { params: { message: error instanceof Error ? error.message : String(error) } }),
  error: true,
})

/** 选文件后先提示覆盖；确认后才检查文件并执行导入，任何错误都提示导入失败。 */
const useHistoryImport = () => {
  const [file, setFile] = useState<File | null>(null)
  const [progress, setProgress] = useState<{ processed: number; total?: number } | null>(null)
  const [status, setStatus] = useState<Status>(null)
  const importing = useRef(false)

  const confirm = async () => {
    if (!file || importing.current) {
      return
    }
    importing.current = true
    setFile(null)
    setProgress({ processed: 0 })
    setStatus(null)
    try {
      const count = await importHistory(file, (processed, total) => setProgress({ processed, total }))
      setStatus({ key: count === 1 ? 'historyImportedOne' : 'historyImported', params: { count } })
    } catch {
      setStatus({ key: 'historyImportFailed', error: true })
    } finally {
      importing.current = false
      setProgress(null)
    }
  }

  return {
    file,
    busy: progress !== null,
    progress,
    status,
    select: setFile,
    cancel: () => setFile(null),
    confirm,
    dismiss: () => {
      setFile(null)
      setStatus(null)
    },
  }
}

/** 导入 = 覆盖：用选中文件替换本地全部会话与附件。 */
const ImportHistory = ({
  historyImport,
  disabled,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
  disabled: boolean
}) => {
  const t = useTranslate()
  const inputRef = useRef<HTMLInputElement>(null)
  const { progress } = historyImport
  const total = progress?.total
  const saving = total !== undefined && progress?.processed === total

  return (
    <SettingCell
      className={progress ? styles.importing : undefined}
      label={t('historyImport')}
      description={t('historyImportDescription')}
      status={historyImport.status}
      action={
        <>
          <Button
            variant="outlined"
            size="m"
            className={clsx(styles.cellButton, styles.uploadButton)}
            aria-busy={historyImport.busy}
            aria-label={progress ? t('historyImport') : undefined}
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
          >
            {progress ? (
              <IconLoadingOutline16 />
            ) : (
              <>
                <IconUploadOutline14 />
                {t('upload')}
              </>
            )}
          </Button>
          <input
            ref={inputRef}
            type="file"
            accept=".zip,application/zip,application/x-zip-compressed"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) {
                historyImport.select(file)
              }
            }}
          />
          {progress && (
            <div className={styles.importProgress}>
              {total !== undefined && total > 0 && (
                <div
                  className={styles.importTrack}
                  role="progressbar"
                  aria-label={t('historyImport')}
                  aria-valuemin={0}
                  aria-valuemax={total}
                  aria-valuenow={progress.processed}
                >
                  <span style={{ width: `${(100 * progress.processed) / total}%` }} />
                </div>
              )}
              <span role="status">
                {saving
                  ? t('historyImportSaving')
                  : total === undefined
                    ? t('historyImportReading')
                    : t('historyImportProgress', { processed: progress.processed, total })}
              </span>
            </div>
          )}
        </>
      }
    />
  )
}

/** 将会话和附件导出为 ZIP 文件 */
const ExportHistory = ({ disabled }: { disabled: boolean }) => {
  const t = useTranslate()
  const empty = useChatStore((state) => state.sessions.length === 0)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)

  const onExport = async () => {
    setBusy(true)
    setStatus(null)
    try {
      const { name, blob } = await exportHistory()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = name
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch (error) {
      setStatus(errorStatus('historyExportFailed', error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingCell
      label={t('exportAllLabel')}
      description={t('historyExportDescription')}
      status={status}
      action={
        <Button
          variant="outlined"
          size="m"
          className={styles.cellButton}
          disabled={disabled || busy || empty}
          onClick={() => void onExport()}
        >
          <IconDownloadOutline16 />
          {t('exportAllDownload')}
        </Button>
      }
    />
  )
}
