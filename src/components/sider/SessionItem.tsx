import clsx from 'clsx'
import { memo, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  IconCheckOutline16,
  IconEditOutline16,
  IconEllipsisOutline16,
  IconPinOutline16,
  IconTrashOutline16,
} from '../base/icons.js'
import { renameSession, selectSession } from '../../services/chat/store.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { IconButton } from '../base/IconButton.js'
import { Menu } from '../base/Menu.js'
import { closeMobileSider } from './mobileSiderState.js'
import styles from './SessionItem.module.css'

export const SessionItem = memo(function SessionItem({
  session,
  active,
  selected,
  disabled,
  onToggle,
  onPin,
  onDelete,
}: {
  session: SessionSummary
  active: boolean
  selected?: boolean
  disabled: boolean
  onToggle: () => void
  onPin: () => void
  onDelete: () => void
}) {
  const t = useTranslate()
  const [editing, setEditing] = useState(false)
  const displayTitle = session.title || t('untitledChat')
  const selecting = selected !== undefined

  if (editing) {
    const finish = (title: string) => {
      setEditing(false)
      if (title.trim() && title.trim() !== displayTitle) {
        renameSession(session.id, title.trim())
      }
    }
    return (
      <input
        className={styles.renameInput}
        defaultValue={displayTitle}
        autoFocus
        onFocus={(event) => event.target.select()}
        onBlur={(event) => finish(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            finish(event.currentTarget.value)
          } else if (event.key === 'Escape') {
            setEditing(false)
          }
        }}
      />
    )
  }

  return (
    <div
      className={clsx(styles.item, active && !selecting && styles.active)}
      data-session-id={session.id}
      data-selecting={selecting}
      data-selected={selected === true}
    >
      <button
        type="button"
        className={styles.rowButton}
        role={selecting ? 'checkbox' : undefined}
        aria-checked={selecting ? selected : undefined}
        aria-current={!selecting && active ? true : undefined}
        disabled={disabled}
        onClick={() => {
          if (selecting) {
            onToggle()
          } else {
            selectSession(session.id)
            closeMobileSider()
          }
        }}
      >
        <span className={styles.indicator} aria-hidden="true">
          <span className={styles.check}>
            <IconCheckOutline16 />
          </span>
        </span>
        <span className={styles.title}>{displayTitle}</span>
      </button>
      {session.pinned && !selecting && (
        <span className={styles.pin}>
          <IconPinOutline16 />
        </span>
      )}
      {!selecting && (
        <div className={styles.action}>
          <Menu
            options={[
              {
                key: 'pin',
                label: t(session.pinned ? 'unpinSessions' : 'pinSessions'),
                icon: <IconPinOutline16 />,
                onSelect: onPin,
              },
              {
                key: 'rename',
                label: t('sessionItemMenuRenameOption'),
                icon: <IconEditOutline16 />,
                onSelect: () => setEditing(true),
              },
              {
                key: 'delete',
                label: t('delete'),
                icon: <IconTrashOutline16 />,
                danger: true,
                onSelect: onDelete,
              },
            ]}
          >
            {({ open, toggle }) => (
              <IconButton
                icon={<IconEllipsisOutline16 />}
                aria-label={t('more')}
                aria-haspopup="menu"
                aria-expanded={open}
                disabled={disabled}
                onClick={toggle}
              />
            )}
          </Menu>
        </div>
      )}
    </div>
  )
})
