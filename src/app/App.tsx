import { useEffect, useState } from 'react'
import { translate, useTranslate } from '../i18n/index.js'
import { useSettings } from '../services/settings.js'
import { loadAccount, loginToAccount, useAccount } from '../services/account.js'
import { useIsMobile, useMobileViewport, usePreventPageScroll } from './viewport.js'
import {
  bindChatPersistence,
  flushChatWorkspace,
  initChat,
  refreshSyncedSessions,
  retrySaveSessions,
  selectSession,
  useChatStore,
} from '../services/chat/store.js'
import { SearchPanel } from '../components/search/SearchPanel.js'
import { closeSearchPanel } from '../components/search/searchPanelState.js'
import { SessionView } from '../components/session/SessionView.js'
import { MobileHeader } from '../components/session/MobileHeader.js'
import { Welcome } from '../components/session/Welcome.js'
import { SettingsDialog } from '../components/settings/SettingsDialog.js'
import { Toast } from '../components/base/Toast.js'
import { showToast } from '../components/base/toastState.js'
import { onUploadNotice } from '../services/attachments.js'
import { Button } from '../components/base/Button.js'
import { stopReadAloud } from '../services/speech/readAloud.js'
import { CollapsedSider } from '../components/sider/CollapsedSider.js'
import { closeMobileSider } from '../components/sider/mobileSiderState.js'
import { MobileSider, Sider } from '../components/sider/Sider.js'
import styles from './App.module.css'
import { ChatSearch, openChatSearch } from '../components/sider/ChatSearch.js'
import { newChat } from '../services/chat/store.js'
import { Brand } from '../components/brand/Brand.js'
import { localAccountStorage, setChatWorkspace } from '../services/chat/db.js'
import { bindWorkspaceDrafts } from '../services/chat/drafts.js'
import { bindWorkspaceFlush, bindWorkspaceSync, workspaceStorageMode } from '../services/workspace.js'
import { bindWorkspacePreferences } from '../services/workspacePreferences.js'
import gate from './AccountGate.module.css'

export const App = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const mode = useAccount((state) => state.mode)
  const user = useAccount((state) => state.user)
  const accountWorkspace = useAccount((state) => state.workspace)
  const workspace = accountWorkspace && workspaceStorageMode(accountWorkspace) === 'account' ? accountWorkspace : null
  const storage = workspace ?? (accountWorkspace ? localAccountStorage(accountWorkspace) : null)
  const [loginError] = useState(() => new URLSearchParams(window.location.search).has('account'))

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  useEffect(() => {
    const url = new URL(window.location.href)
    if (url.searchParams.has('account')) {
      url.searchParams.delete('account')
      history.replaceState(null, '', url)
    }
    void loadAccount()
    const refresh = (event: PageTransitionEvent) => {
      if (event.persisted) void loadAccount()
    }
    window.addEventListener('pageshow', refresh)
    return () => window.removeEventListener('pageshow', refresh)
  }, [])

  if (mode === 'local' || (mode === 'account' && user)) return <ChatApp workspace={workspace} storage={storage} />

  return (
    <main className={gate.page}>
      <section className={gate.content} aria-labelledby="sign-in-title">
        <h1 id="sign-in-title" className={gate.heading} aria-label={t('accountLoginTitle')}>
          <Brand className={gate.brand} />
        </h1>
        {mode === 'checking' ? (
          <p role="status">{t('accountChecking')}</p>
        ) : mode === 'error' ? (
          <>
            <p role="alert">{t('accountCheckFailed')}</p>
            <Button block onClick={() => void loadAccount()}>
              {t('retry')}
            </Button>
          </>
        ) : (
          <>
            {loginError && <p role="alert">{t('accountLoginFailed')}</p>}
            <Button block onClick={loginToAccount}>
              {t('accountSignIn')}
            </Button>
          </>
        )}
      </section>
    </main>
  )
}

const ChatApp = ({ workspace, storage }: { workspace: string | null; storage: string | null }) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  // 移动端侧边栏以独立抽屉管理开合状态
  const siderCollapsed = useSettings((state) => state.siderCollapsed) && !isMobile
  const ready = useChatStore((state) => state.ready)
  const initError = useChatStore((state) => state.initError)
  const saveError = useChatStore((state) => Object.values(state.sessionSaveErrors).some(Boolean))
  const importingHistory = useChatStore((state) => state.importingHistory)
  const session = useChatStore((state) =>
    state.activeId !== null && Object.hasOwn(state.sessionCache, state.activeId)
      ? state.sessionCache[state.activeId]
      : undefined
  )
  const sessionLoadError = useChatStore((state) =>
    state.activeId === null ? false : state.sessionLoadErrors[state.activeId] === true
  )
  const frameRef = useMobileViewport(isMobile)
  const streaming = useChatStore((state) =>
    state.activeId === null ? false : Object.hasOwn(state.streaming, state.activeId)
  )
  const activeId = useChatStore((state) => state.activeId)

  usePreventPageScroll(isMobile)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        openChatSearch()
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'j') {
        event.preventDefault()
        newChat()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 文件数、存储空间达到上限时，附件上只显示「上传失败」，原因用 toast 说明
  useEffect(() => onUploadNotice(showToast), [])
  useEffect(bindChatPersistence, [])

  // 搜索结果面板只属于当前会话
  useEffect(closeSearchPanel, [activeId])
  // 切换会话或退出聊天页时停止朗读
  useEffect(() => stopReadAloud, [activeId])
  // 移动端选中会话、切换布局后收起抽屉
  useEffect(closeMobileSider, [activeId, isMobile])

  useEffect(() => {
    setChatWorkspace(storage)
    const ready = initChat()
    const onError = () => showToast({ key: 'workspaceSaveFailed', type: 'error' })
    const preferences = storage ? bindWorkspacePreferences(storage, onError) : undefined
    const drafts = bindWorkspaceDrafts(storage ?? localAccountStorage('standalone-drafts'), onError)
    const unbindFlush = bindWorkspaceFlush(async () => {
      await flushChatWorkspace()
      await Promise.all([drafts.flush(), preferences?.flush()])
    })
    void preferences?.restore().catch(onError)
    void drafts.restore().catch(onError)
    let stopped = false
    let stopSync: (() => void) | undefined
    void ready.then(() => {
      if (stopped || !workspace) return
      stopSync = bindWorkspaceSync(workspace, {
        canSync: () => !useChatStore.getState().importingHistory,
        canSyncSession: (id) => !Object.hasOwn(useChatStore.getState().streaming, id),
        onChange: async (kinds) => {
          if (kinds.has('settings')) await preferences?.restore()
          if (kinds.has('drafts') || kinds.has('files')) await drafts.restore()
          if (kinds.has('sessions')) await refreshSyncedSessions()
        },
        conflictTitle: (title) => translate('workspaceConflictTitle', { title: title || translate('untitledChat') }),
      })
    })
    return () => {
      stopped = true
      stopSync?.()
      preferences?.stop()
      drafts.stop()
      unbindFlush()
    }
  }, [storage, workspace])

  return (
    <>
      <div ref={frameRef} className={styles.frame} data-sider-collapsed={siderCollapsed}>
        {isMobile ? (
          <MobileSider />
        ) : (
          <div
            className={styles.sidebarSlot}
            aria-hidden={siderCollapsed}
            ref={(element) => {
              if (element) element.inert = siderCollapsed
            }}
          >
            <Sider />
          </div>
        )}
        <main className={styles.main}>
          {saveError ? (
            <div className={styles.saveError} role="alert">
              <span>{t('sessionSaveFailed')}</span>
              <Button
                variant="outlined"
                size="s"
                disabled={importingHistory}
                onClick={retrySaveSessions}
              >
                {t('retry')}
              </Button>
            </div>
          ) : null}
          <div className={styles.content}>
            {siderCollapsed ? <CollapsedSider /> : null}
            {!ready || (activeId !== null && !session) ? (
              <div className={styles.loadingView}>
                {isMobile ? <MobileHeader /> : null}
                <div className={styles.loadingState} role="status" aria-live="polite">
                  <span>
                    {(!ready ? initError : sessionLoadError)
                      ? t(!ready ? 'sessionListLoadFailed' : 'sessionLoadFailed')
                      : t('sessionLoading')}
                  </span>
                  {(!ready ? initError : sessionLoadError) ? (
                    <Button
                      variant="outlined"
                      size="m"
                      onClick={() => {
                        if (!ready) {
                          void initChat()
                        } else if (activeId !== null) {
                          selectSession(activeId)
                        }
                      }}
                    >
                      {t('retry')}
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : session ? (
              <SessionView
                key={session.id}
                session={session}
                streaming={streaming}
                siderCollapsed={siderCollapsed}
              />
            ) : (
              <Welcome />
            )}
          </div>
        </main>
        <SearchPanel />
      </div>
      <SettingsDialog />
      <ChatSearch />
      <Toast />
    </>
  )
}
