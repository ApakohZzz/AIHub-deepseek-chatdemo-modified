import clsx from 'clsx'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  IconCloseOutline16,
  IconCubeOutline16,
  IconDataOutline16,
  IconEllipsisOutline16,
  IconPanelLeftOutline16,
  IconPinOutline16,
  IconSearchOutline16,
  IconSelectOutline16,
  IconSettingsOutline16,
  IconSignOutOutline16,
  IconTrashOutline16,
  NewChatIcon,
} from '../base/icons.js'
import { setSiderCollapsed } from '../../services/settings.js'
import { logoutFromAccount, useAccount } from '../../services/account.js'
import { groupSessions } from '../../services/chat/sessionGroups.js'
import {
  newChat,
  removeSessions,
  setSessionsPinned,
  useChatStore,
} from '../../services/chat/store.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { Modal, ModalPresence } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { closeMobileSider, useMobileSider } from './mobileSiderState.js'
import { SessionItem } from './SessionItem.js'
import styles from './Sider.module.css'
import { Brand } from '../brand/Brand.js'
import { Menu } from '../base/Menu.js'
import { openChatSearch } from './ChatSearch.js'

/** 展开的侧边栏：名称与收起按钮、开启新对话、按时间分组的会话列表、底部设置；移动端放在抽屉里，收起按钮关闭抽屉 */
export const Sider = ({ mobile = false }: { mobile?: boolean }) => {
  const t = useTranslate()
  const accountUser = useAccount((state) => state.user)
  const [failedAvatar, setFailedAvatar] = useState<string | null>(null)
  const avatarUrl = accountUser?.avatarUrl
  const sessions = useChatStore((state) => state.sessions)
  const activeId = useChatStore((state) => state.activeId)
  const importing = useChatStore((state) => state.importingHistory)
  const mobileOpen = useMobileSider((state) => state.open)
  const [now, setNow] = useState(Date.now)
  const groups = useMemo(() => groupSessions(sessions, now, t), [sessions, now, t])
  const listRef = useRef<HTMLDivElement>(null)
  const rowPositions = useRef(new Map<string, number>())
  const selectionHeaderRef = useRef<HTMLDivElement>(null)
  const selectTriggerRef = useRef<HTMLSpanElement>(null)
  const [selection, setSelection] = useState<Set<string> | null>(null)
  const [deleting, setDeleting] = useState<string[] | null>(null)
  const [pending, setPending] = useState(false)
  const selecting = selection !== null
  const wasSelecting = useRef(false)
  const selected = selecting ? sessions.filter((session) => selection.has(session.id)) : []
  const allSelected = sessions.length > 0 && selected.length === sessions.length
  const allPinned = selected.length > 0 && selected.every((session) => session.pinned)
  const disabled = pending || importing

  const toggleSession = (id: string) => {
    setSelection((current) => {
      if (!current) {
        return current
      }
      const next = new Set(current)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const pin = async (ids: string[], pinned: boolean, exitSelection = false) => {
    if (disabled) {
      return
    }
    setPending(true)
    try {
      if (await setSessionsPinned(ids, pinned)) {
        if (exitSelection) {
          setSelection(null)
        }
      } else {
        showToast({ key: 'sessionPinFailed', type: 'error' })
      }
    } finally {
      setPending(false)
    }
  }

  useEffect(() => {
    if (importing || (mobile && !mobileOpen)) {
      setSelection(null)
    }
  }, [importing, mobile, mobileOpen])

  useEffect(() => {
    const previous = wasSelecting.current
    wasSelecting.current = selecting
    if ((!previous && !selecting) || (mobile && !mobileOpen)) {
      return
    }
    const frame = requestAnimationFrame(() => {
      const target = selecting
        ? selectionHeaderRef.current
        : selectTriggerRef.current?.querySelector('button')
      target?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [selecting, mobile, mobileOpen])

  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) {
      return
    }
    const previous = rowPositions.current
    const rows = [...list.querySelectorAll<HTMLElement>('[data-session-id]')].map((element) => ({
      element,
      id: element.dataset.sessionId ?? '',
      top: element.getBoundingClientRect().top + list.scrollTop,
    }))
    rowPositions.current = new Map(rows.map(({ id, top }) => [id, top]))
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return
    }
    for (const { element, id, top } of rows) {
      const distance = (previous.get(id) ?? top) - top
      if (Math.abs(distance) > 1 && Math.abs(distance) < list.clientHeight) {
        element.animate(
          [{ transform: `translateY(${distance}px)` }, { transform: 'translateY(0)' }],
          {
            duration: 190,
            easing: 'cubic-bezier(.2,.75,.25,1)',
          }
        )
      }
    }
  }, [groups])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const refresh = () => {
      clearTimeout(timer)
      const time = Date.now()
      setNow(time)
      const midnight = new Date(time).setHours(24, 0, 0, 0)
      timer = setTimeout(refresh, midnight - time)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refresh()
      }
    }
    refresh()
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', refresh)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', refresh)
    }
  }, [])

  return (
    <div
      className={clsx(styles.sider, mobile && styles.mobile)}
      data-selecting={selecting}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && selecting && !deleting && !pending) {
          setSelection(null)
        }
      }}
    >
      <div className={styles.top}>
        <Brand />
        <div className={styles.topActions}>
          <span className={styles.searchAction} aria-hidden={selecting}>
            <IconButton
              size="m"
              icon={<IconSearchOutline16 />}
              tooltip={t('searchChats')}
              disabled={selecting}
              onClick={openChatSearch}
            />
          </span>
          <IconButton
            size="m"
            icon={<IconPanelLeftOutline16 />}
            tooltip={t('collapseSiderbarButton')}
            tooltipPlacement="bottom"
            onClick={() => {
              setSelection(null)
              if (mobile) {
                closeMobileSider()
              } else {
                setSiderCollapsed(true)
              }
            }}
          />
        </div>
      </div>
      <div className={styles.actionSlot}>
        <button
          type="button"
          className={styles.newChat}
          disabled={disabled || selecting}
          aria-hidden={selecting}
          onClick={() => {
            newChat()
            closeMobileSider()
          }}
        >
          <span className={styles.newChatIcon}>
            <NewChatIcon />
          </span>
          {t('newChat')}
        </button>
        <div
          ref={selectionHeaderRef}
          className={styles.selectionHeader}
          aria-hidden={!selecting}
          tabIndex={-1}
        >
          <span role="status">
            {selected.length
              ? t('selectedSessions', { count: selected.length })
              : t('selectSessionsPrompt')}
          </span>
          <button
            type="button"
            className={styles.selectAll}
            disabled={disabled || !selecting || !sessions.length}
            onClick={() => setSelection(new Set(allSelected ? [] : sessions.map(({ id }) => id)))}
          >
            {t(allSelected ? 'deselectAllSessions' : 'selectAllSessions')}
          </button>
          <IconButton
            icon={<IconCloseOutline16 />}
            className={styles.exitSelection}
            tooltip={t('exitSelection')}
            disabled={disabled || !selecting}
            onClick={() => setSelection(null)}
          />
        </div>
      </div>
      <div className={styles.listWrap}>
        <div ref={listRef} className={styles.list}>
          {groups.map((group, index) => (
            <div key={group.key} className={styles.section}>
              <div className={styles.sectionHeader}>
                {group.label}
                {index === 0 && (
                  <span
                    ref={selectTriggerRef}
                    className={styles.selectTrigger}
                    aria-hidden={selecting}
                  >
                    <IconButton
                      icon={<IconSelectOutline16 />}
                      tooltip={selecting ? undefined : t('selectSessions')}
                      disabled={disabled || selecting}
                      onClick={() => setSelection(new Set())}
                    />
                  </span>
                )}
              </div>
              {group.sessions.map((session) => (
                <SessionItem
                  key={session.id}
                  session={session}
                  active={session.id === activeId}
                  selected={selection?.has(session.id)}
                  disabled={disabled}
                  onToggle={() => toggleSession(session.id)}
                  onPin={() => {
                    void pin([session.id], !session.pinned)
                  }}
                  onDelete={() => setDeleting([session.id])}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className={styles.bottom}>
        {selecting ? (
          <div className={styles.batchActions}>
            <button
              type="button"
              disabled={disabled || !selected.length}
              onClick={() => {
                void pin(
                  selected.map(({ id }) => id),
                  !allPinned,
                  true
                )
              }}
            >
              <IconPinOutline16 />
              {t(allPinned ? 'unpinSessions' : 'pinSessions')}
            </button>
            <button
              type="button"
              className={styles.batchDelete}
              disabled={disabled || !selected.length}
              onClick={() => setDeleting(selected.map(({ id }) => id))}
            >
              <IconTrashOutline16 />
              {t('delete')}
            </button>
          </div>
        ) : (
          <Menu
            side="top"
            options={[
              {
                key: 'providers',
                label: t('providers'),
                icon: <IconCubeOutline16 />,
                onSelect: () => openSettings('providers'),
              },
              {
                key: 'settings',
                label: t('settings'),
                icon: <IconSettingsOutline16 />,
                onSelect: () => openSettings('general'),
              },
              {
                key: 'data',
                label: t('settingDialogAsideDataOptionLabel'),
                icon: <IconDataOutline16 />,
                onSelect: () => openSettings('data'),
              },
              ...(accountUser
                ? [
                    {
                      key: 'sign-out',
                      label: t('accountSignOut'),
                      icon: <IconSignOutOutline16 />,
                      onSelect: () => {
                        void logoutFromAccount().catch(() =>
                          showToast({ key: 'accountRequestFailed', type: 'error' })
                        )
                      },
                    },
                  ]
                : []),
            ]}
          >
            {({ open, toggle }) => (
              <button
                type="button"
                className={styles.settings}
                aria-label={t('settings')}
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={toggle}
              >
                {avatarUrl && avatarUrl !== failedAvatar ? (
                  <img
                    className={styles.workspaceAvatar}
                    src={avatarUrl}
                    alt=""
                    referrerPolicy="no-referrer"
                    draggable={false}
                    onError={() => setFailedAvatar(avatarUrl)}
                  />
                ) : (
                  <Brand symbolOnly className={styles.workspaceMark} />
                )}
                <span className={styles.workspaceText}>
                  <span>{accountUser?.login ?? t('appName')}</span>
                  {!accountUser && <small>{t('localWorkspace')}</small>}
                </span>
                <span className={styles.workspaceMore} aria-hidden="true">
                  <IconEllipsisOutline16 />
                </span>
              </button>
            )}
          </Menu>
        )}
      </div>
      <ModalPresence>
        {deleting ? (
          <Modal
            title={
              deleting.length === 1
                ? t('deleteSessionModalContentTitle')
                : t('deleteSelectedSessionsTitle', { count: deleting.length })
            }
            onClose={() => {
              if (!pending) {
                setDeleting(null)
              }
            }}
            footer={
              <>
                <Button variant="outlined" disabled={pending} onClick={() => setDeleting(null)}>
                  {t('cancel')}
                </Button>
                <Button
                  variant="danger"
                  disabled={disabled}
                  onClick={async () => {
                    setPending(true)
                    try {
                      if (await removeSessions(deleting)) {
                        setDeleting(null)
                        setSelection(null)
                      } else {
                        showToast({ key: 'sessionDeleteFailed', type: 'error' })
                      }
                    } finally {
                      setPending(false)
                    }
                  }}
                >
                  {t('delete')}
                </Button>
              </>
            }
          >
            {deleting.length === 1
              ? t('deleteSessionWithFilesDescription')
              : t('deleteSelectedSessionsDescription')}
          </Modal>
        ) : null}
      </ModalPresence>
    </div>
  )
}

/** 移动端抽屉：浮在页面上方，点空白区域关闭。 */
export const MobileSider = () => {
  const open = useMobileSider((state) => state.open)
  return (
    <>
      <div className={styles.drawerMask} data-open={open} onClick={closeMobileSider} />
      <div
        className={styles.drawer}
        data-open={open}
        aria-hidden={!open}
        ref={(element) => {
          if (element) {
            element.inert = !open
          }
        }}
      >
        <Sider mobile />
      </div>
    </>
  )
}
