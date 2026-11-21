import clsx from 'clsx'
import type { ReactNode } from 'react'
import { useTranslate, type TranslationKey, type TranslationMessage } from '../../i18n/index.js'
import styles from './Settings.module.css'

/** `reason` is translated before being passed as the message parameter. */
export type SettingStatus = (TranslationMessage & { error?: boolean; reason?: TranslationKey }) | null

export const SettingCell = ({
  label,
  description,
  status,
  action,
  className,
}: {
  label: ReactNode
  description?: ReactNode
  status?: SettingStatus
  action: ReactNode
  className?: string
}) => {
  const t = useTranslate()
  return (
    <div className={clsx(styles.cell, styles.row, className)}>
      <div className={styles.text}>
        <div className={styles.label}>{label}</div>
        {status || description ? (
          <div className={clsx(styles.description, status?.error && styles.error)}>
            {status
              ? t(status.key, status.reason ? { message: t(status.reason) } : status.params)
              : description}
          </div>
        ) : null}
      </div>
      {action}
    </div>
  )
}
