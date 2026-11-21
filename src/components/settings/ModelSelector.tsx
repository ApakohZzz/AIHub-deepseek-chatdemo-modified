import { useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { getSessionSelection, setSessionModel, useChatStore } from '../../services/chat/store.js'
import { getModelName } from '../../services/modelCatalog.js'
import { selectModel, useProviders } from '../../services/providers.js'
import { useTranslate } from '../../i18n/index.js'
import { useAnchoredPosition, useDismiss } from '../base/anchored.js'
import {
  IconCheckOutline16,
  IconChevronDownOutline14,
  IconCubeOutline16,
} from '../base/icons.js'
import { useOverlayPresence } from '../base/useOverlayPresence.js'
import { ProviderIcon } from '../brand/ProviderIcon.js'
import { openSettings } from './settingsDialogState.js'
import styles from './ModelSelector.module.css'

export const ModelSelector = ({ sessionId }: { sessionId: string | null }) => {
  const t = useTranslate()
  const profiles = useProviders((state) => state.profiles)
  useProviders((state) => state.selection)
  useChatStore((state) => (sessionId ? state.sessionCache[sessionId]?.connection : undefined))
  const busy = useChatStore(
    (state) => state.importingHistory || (sessionId !== null && !!state.streaming[sessionId])
  )
  const selection = getSessionSelection(sessionId)
  const provider = profiles.find((profile) => profile.id === selection.providerId)
  const [open, setOpen] = useState(false)
  const { content: present, exitProps } = useOverlayPresence(open ? true : null)
  const { anchorRef, floatingRef, position, side } = useAnchoredPosition<
    HTMLButtonElement,
    HTMLDivElement
  >(present !== null, { side: 'top', align: 'end', maxHeight: 380, minSpace: 160 })
  const close = () => {
    if (floatingRef.current?.contains(document.activeElement)) {
      anchorRef.current?.focus({ preventScroll: true })
    }
    setOpen(false)
  }
  useDismiss(open, [anchorRef, floatingRef], close, { captureEscape: true })
  const positioned = Boolean(position)
  useLayoutEffect(() => {
    if (!open || !positioned) return
    const menu = floatingRef.current
    const first = menu?.querySelector<HTMLButtonElement>('[aria-selected="true"]') ??
      menu?.querySelector<HTMLButtonElement>('button')
    first?.focus()
  }, [floatingRef, open, positioned])
  return (
    <div className={styles.root}>
      <button
        ref={anchorRef}
        className={styles.trigger}
        type="button"
        aria-label={t('selectModel')}
        title={provider ? selection.model : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen((value) => !value)}
      >
        <ProviderIcon provider={provider} />
        <span>{provider ? getModelName(provider, selection.model) : t('providerRemoved')}</span>
        <IconChevronDownOutline14 />
      </button>
      {present &&
        createPortal(
          <div
            ref={floatingRef}
            className={styles.menu}
            style={position}
            role="dialog"
            aria-label={t('selectModel')}
            data-menu-side={side ?? 'bottom'}
            {...exitProps}
          >
            <div className={styles.options} role="listbox" aria-label={t('selectModel')}>
              {profiles.map((profile) => {
                const fallback = profile.defaultModel && !profile.models.includes(profile.defaultModel)
                  ? profile.defaultModel
                  : ''
                const models = fallback ? [...profile.models, fallback] : profile.models
                return (
                  models.length > 0 && (
                    <div key={profile.id} className={styles.group}>
                      <div className={styles.groupLabel}>{profile.name}</div>
                      {models.map((model) => (
                        <button
                          key={model}
                          className={styles.option}
                          type="button"
                          role="option"
                          title={model}
                          aria-selected={
                            selection.providerId === profile.id && selection.model === model
                          }
                          onClick={() => {
                            const next = { providerId: profile.id, model }
                            setSessionModel(sessionId, next)
                            selectModel(next)
                            close()
                          }}
                        >
                          <span className={styles.optionLabel}>
                            <ProviderIcon provider={profile} />
                            <span>{model === fallback ? t('catalogUseDefault') : getModelName(profile, model)}</span>
                          </span>
                          {selection.providerId === profile.id && selection.model === model && (
                            <IconCheckOutline16 />
                          )}
                        </button>
                      ))}
                    </div>
                  )
                )
              })}
            </div>
            <div className={styles.footer}>
              <button
                type="button"
                className={styles.manage}
                onClick={() => {
                  setOpen(false)
                  openSettings('providers')
                }}
              >
                <IconCubeOutline16 />
                {t('configureProviders')}
              </button>
            </div>
          </div>,
          document.body
        )}
    </div>
  )
}
