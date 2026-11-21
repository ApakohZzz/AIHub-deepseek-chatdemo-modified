import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { listModels } from '../../services/api/models.js'
import type { ModelEntry } from '../../services/modelCatalog.js'
import type { ProviderProfile } from '../../services/providers.js'
import { Button } from '../base/Button.js'
import fieldStyles from '../base/FormField.module.css'
import { Modal } from '../base/Modal.js'
import styles from './ModelCatalog.module.css'

export const ModelDiscoveryDialog = ({
  provider,
  existing,
  onApply,
  onClose,
}: {
  provider: ProviderProfile
  existing: ModelEntry[]
  onApply: (found: ModelEntry[], selected: ReadonlySet<string>) => void
  onClose: () => void
}) => {
  const t = useTranslate()
  const [query, setQuery] = useState('')
  const [models, setModels] = useState<ModelEntry[] | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [selected, setSelected] = useState(() => new Set(existing.map(({ id }) => id.trim())))
  useEffect(() => {
    const controller = new AbortController()
    listModels(provider, controller.signal).then(
      (found) => {
        if (!controller.signal.aborted) setModels(found)
      },
      (failure) => {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure))
      }
    )
    return () => controller.abort()
  }, [attempt, provider])
  const search = query.trim().toLowerCase()
  const visible = models?.filter(({ id, name }) => `${id} ${name ?? ''}`.toLowerCase().includes(search)) ?? []
  const allVisible = visible.length > 0 && visible.every(({ id }) => selected.has(id))
  const setChecked = (ids: string[], checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current)
      for (const id of ids) {
        if (checked) next.add(id)
        else next.delete(id)
      }
      return next
    })
  return (
    <Modal
      title={t('catalogDiscoveryTitle')}
      closable
      className={styles.discovery}
      mainClassName={styles.discoveryBody}
      onClose={onClose}
      footer={
        <>
          <Button size="m" variant="outlined" onClick={onClose}>{t('cancel')}</Button>
          {error ? (
            <Button size="m" onClick={() => {
              setError('')
              setAttempt((value) => value + 1)
            }}>{t('retry')}</Button>
          ) : (
            <Button size="m" disabled={!models?.length} onClick={() => {
              if (models?.length) onApply(models, selected)
            }}>{t('catalogUpdate')}</Button>
          )}
        </>
      }
    >
      <p className={styles.hint}>{t('catalogDiscoveryHint')}</p>
      {error ? (
        <p role="alert" className={styles.empty}>{error}</p>
      ) : models === null ? (
        <p role="status" className={styles.empty}>{t('catalogFetching')}</p>
      ) : models.length === 0 ? (
        <p role="status" className={styles.empty}>{t('catalogNoModels')}</p>
      ) : (
        <>
          <div className={styles.discoverySearch}>
            <input
              type="search"
              className={`${fieldStyles.field} ${styles.input}`}
              aria-label={t('catalogFind')}
              placeholder={t('catalogFind')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <Button
              size="s"
              variant="text"
              disabled={!visible.length}
              onClick={() => setChecked(visible.map(({ id }) => id), !allVisible)}
            >
              {t(search
                ? allVisible ? 'catalogClearResults' : 'catalogSelectResults'
                : allVisible ? 'catalogClearAll' : 'catalogSelectAll')}
            </Button>
          </div>
          <div className={styles.discoveryOptions}>
            {visible.length ? visible.map(({ id, name }) => (
              <label key={id} className={styles.discoveredModel}>
                <input type="checkbox" checked={selected.has(id)} onChange={(event) => setChecked([id], event.target.checked)} />
                <span>
                  {name || id}
                  {name && name !== id && <small>{id}</small>}
                </span>
              </label>
            )) : <p className={styles.empty}>{t('catalogNoResults')}</p>}
          </div>
        </>
      )}
    </Modal>
  )
}
