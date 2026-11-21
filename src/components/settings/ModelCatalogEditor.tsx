import {
  useId,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction,
} from 'react'
import { useTranslate } from '../../i18n/index.js'
import { moveModelRow, type ModelEntry, type ModelParameters } from '../../services/modelCatalog.js'
import { Button } from '../base/Button.js'
import fieldStyles from '../base/FormField.module.css'
import { IconButton } from '../base/IconButton.js'
import { IconChevronRightOutline14, IconGripOutline16, IconTrashOutline16 } from '../base/icons.js'
import styles from './ModelCatalog.module.css'

export type CatalogRow = {
  key: string
  id: string
  name: string
  contextWindow: string
  maxOutputTokens: string
}

export const createCatalogRow = (
  { id, name }: ModelEntry,
  parameters?: ModelParameters
): CatalogRow => ({
  key: crypto.randomUUID(),
  id,
  name: name ?? '',
  contextWindow: parameters?.contextWindow?.toString() ?? '',
  maxOutputTokens: parameters?.maxOutputTokens?.toString() ?? '',
})

type Drop = { key: string; edge: 'before' | 'after' }

export const ModelCatalogEditor = ({
  rows,
  setRows,
  disabled,
  fetchDisabled,
  fetchHint,
  onFetch,
  limitsFor,
}: {
  rows: CatalogRow[]
  setRows: Dispatch<SetStateAction<CatalogRow[]>>
  disabled: boolean
  fetchDisabled: boolean
  fetchHint?: string
  onFetch: () => void
  limitsFor: (id: string) => ModelParameters
}) => {
  const t = useTranslate()
  const id = useId()
  const catalog = useRef<HTMLElement>(null)
  const drag = useRef<AbortController | null>(null)
  const [drop, setDrop] = useState<Drop | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => () => drag.current?.abort(), [])
  const dropAt = (event: PointerEvent, source: string, startY: number): Drop | null => {
    if (Math.abs(event.clientY - startY) < 4) {
      return null
    }
    const row = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>('[data-catalog-row]')
    const key = row?.dataset.catalogRow
    if (!row || !key || key === source || !catalog.current?.contains(row)) {
      return null
    }
    const bounds = row.getBoundingClientRect()
    return { key, edge: event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after' }
  }
  const beginDrag = (event: ReactPointerEvent<HTMLButtonElement>, key: string) => {
    if (!event.isPrimary || event.button !== 0 || drag.current) {
      return
    }
    event.preventDefault()
    event.currentTarget.focus({ preventScroll: true })
    const { pointerId, clientY: startY } = event
    const controller = new AbortController()
    drag.current = controller
    const options = { signal: controller.signal }
    const finish = () => {
      controller.abort()
      drag.current = null
      setDrop(null)
    }
    document.addEventListener(
      'pointermove',
      (pointer) => {
        if (pointer.pointerId !== pointerId) {
          return
        }
        if (pointer.buttons === 0) {
          finish()
        } else {
          setDrop(dropAt(pointer, key, startY))
        }
      },
      options
    )
    document.addEventListener(
      'pointerup',
      (pointer) => {
        if (pointer.pointerId !== pointerId) {
          return
        }
        const target = dropAt(pointer, key, startY)
        if (target) {
          setRows((current) => moveModelRow(current, key, target.key, target.edge))
        }
        finish()
      },
      options
    )
    document.addEventListener(
      'pointercancel',
      (pointer) => {
        if (pointer.pointerId === pointerId) {
          finish()
        }
      },
      options
    )
    window.addEventListener('blur', finish, options)
  }
  const update = (key: string, field: Exclude<keyof CatalogRow, 'key'>, value: string) =>
    setRows((current) => current.map((row) => (row.key === key ? { ...row, [field]: value } : row)))
  return (
    <section ref={catalog} className={styles.catalog} aria-label={t('modelCatalog')}>
      <div className={styles.heading}>
        <span>{t('modelCatalog')}</span>
        <Button
          variant="outlined"
          size="m"
          className={styles.fetch}
          disabled={fetchDisabled}
          aria-describedby={fetchHint}
          onClick={onFetch}
        >
          {t('catalogFetch')}
        </Button>
      </div>
      {rows.length > 0 ? (
        <div className={styles.rows}>
          <div className={styles.columns} aria-hidden="true">
            <span>{t('catalogModelId')}</span>
            <span>{t('catalogModelName')}</span>
          </div>
          {rows.map((row, index) => {
            const model = row.id || index + 1
            const open = expanded.has(row.key)
            const detailId = `${id}-${row.key}`
            const limits = open ? limitsFor(row.id.trim()) : {}
            return (
              <div
                className={styles.row}
                key={row.key}
                data-catalog-row={row.key}
                data-drop-edge={drop?.key === row.key ? drop.edge : undefined}
              >
                <IconButton
                  className={styles.grip}
                  icon={<IconGripOutline16 />}
                  disabled={disabled || rows.length < 2}
                  aria-label={t('catalogDrag', { model })}
                  onPointerDown={(event) => beginDrag(event, row.key)}
                  onKeyDown={(event) => {
                    if (!['ArrowUp', 'ArrowDown'].includes(event.key)) {
                      return
                    }
                    event.preventDefault()
                    const before = event.key === 'ArrowUp'
                    const target = rows[index + (before ? -1 : 1)]
                    if (target) {
                      setRows((current) =>
                        moveModelRow(current, row.key, target.key, before ? 'before' : 'after')
                      )
                    }
                  }}
                />
                <input
                  className={`${fieldStyles.field} ${styles.input}`}
                  aria-label={t('catalogModelId')}
                  placeholder={t('catalogModelId')}
                  value={row.id}
                  maxLength={200}
                  required
                  disabled={disabled}
                  onChange={(event) => update(row.key, 'id', event.target.value)}
                />
                <input
                  className={`${fieldStyles.field} ${styles.input}`}
                  aria-label={t('catalogModelName')}
                  placeholder={t('catalogModelName')}
                  value={row.name}
                  maxLength={200}
                  disabled={disabled}
                  onChange={(event) => update(row.key, 'name', event.target.value)}
                />
                <div className={styles.actions}>
                  <IconButton
                    className={styles.chevron}
                    icon={<IconChevronRightOutline14 />}
                    aria-label={t(open ? 'catalogCollapseDetails' : 'catalogExpandDetails', {
                      model,
                    })}
                    aria-expanded={open}
                    aria-controls={detailId}
                    onClick={() =>
                      setExpanded((current) => {
                        const next = new Set(current)
                        if (next.has(row.key)) {
                          next.delete(row.key)
                        } else {
                          next.add(row.key)
                        }
                        return next
                      })
                    }
                  />
                  <IconButton
                    icon={<IconTrashOutline16 />}
                    disabled={disabled}
                    aria-label={t('catalogRemove', { model })}
                    onClick={() =>
                      setRows((current) => current.filter((entry) => entry.key !== row.key))
                    }
                  />
                </div>
                <div id={detailId} className={styles.details} hidden={!open}>
                  {open &&
                    (['contextWindow', 'maxOutputTokens'] as const).map((field) => (
                      <label key={field}>
                        {t(
                          field === 'contextWindow'
                            ? 'catalogContextWindow'
                            : 'catalogMaxOutputTokens'
                        )}
                        <input
                          className={`${fieldStyles.field} ${styles.input}`}
                          inputMode="numeric"
                          maxLength={16}
                          value={row[field]}
                          placeholder={
                            limits[field]
                              ? t('catalogDiscoveredLimit', {
                                  count: limits[field].toLocaleString(),
                                })
                              : t('catalogUnknownLimit')
                          }
                          disabled={disabled}
                          onChange={(event) => update(row.key, field, event.target.value)}
                        />
                      </label>
                    ))}
                  {open && <small>{t('catalogLimitHint')}</small>}
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <p className={styles.empty}>{t('catalogEmpty')}</p>
      )}
      <Button
        variant="outlined"
        size="s"
        disabled={disabled || rows.length >= 512}
        onClick={() => setRows((current) => [...current, createCatalogRow({ id: '' })])}
      >
        <span aria-hidden="true">＋</span>
        {t('catalogAdd')}
      </Button>
    </section>
  )
}
