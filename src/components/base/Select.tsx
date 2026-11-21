import clsx from 'clsx'
import { useEffect, useId, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPosition, useDismiss } from './anchored.js'
import { IconCheckOutline16, IconChevronDownOutline14 } from './icons.js'
import fieldStyles from './FormField.module.css'
import styles from './Select.module.css'
import { useOverlayPresence } from './useOverlayPresence.js'

export type SelectOption<T extends string> = {
  value: T
  label: string
  lang?: string
  icon?: ReactNode
}

/**
 * 选择器复用通用表单框体，下拉菜单选中项右侧打勾。
 * 点外部或 Esc 关闭。value 不匹配任何选项时触发器显示 placeholder。
 */
export const Select = <T extends string>({
  value,
  options,
  onChange,
  placeholder,
  ariaLabel,
  className,
  disabled = false,
}: {
  value: T
  options: SelectOption<T>[]
  onChange: (value: T) => void
  placeholder?: string
  ariaLabel?: string
  className?: string
  disabled?: boolean
}) => {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState<number | null>(null)
  const menuId = useId()
  const shown = open && !disabled
  const { content: present, exitProps } = useOverlayPresence(shown ? true : null)
  const current = options.find((option) => option.value === value)
  const activeOption = active === null ? undefined : options[active]
  const activeId = shown && activeOption ? `${menuId}-${active}` : undefined
  // 菜单贴右侧展开，最多 320px 高，超出在菜单内滚动
  const { anchorRef, floatingRef, position, side } = useAnchoredPosition<
    HTMLButtonElement,
    HTMLDivElement
  >(present !== null, { align: 'end', maxHeight: 320, minSpace: 160 })
  // Esc 只关菜单，不让外层弹窗一起关闭
  useDismiss(shown, [anchorRef, floatingRef], () => setOpen(false), { captureEscape: true })

  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' })
  }, [activeId])

  const choose = (option: SelectOption<T>) => {
    setOpen(false)
    onChange(option.value)
  }

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        role="combobox"
        className={clsx(fieldStyles.field, styles.trigger, className)}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={shown}
        aria-controls={present ? menuId : undefined}
        aria-activedescendant={activeId}
        disabled={disabled}
        onClick={() => {
          setActive(null)
          setOpen((value) => !value)
        }}
        onKeyDown={(event) => {
          const { key } = event
          if (key === 'Tab') {
            setOpen(false)
          } else if (shown && activeOption && (key === 'Enter' || key === ' ')) {
            event.preventDefault()
            choose(activeOption)
          } else if (options.length && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(key)) {
            event.preventDefault()
            const index =
              activeId && active !== null ? active : options.findIndex((option) => option === current)
            const last = options.length - 1
            const destinations: Record<string, number> = {
              Home: 0,
              End: last,
              ArrowDown: Math.min(last, index + 1),
              ArrowUp: index < 0 ? last : Math.max(0, index - 1),
            }
            const next = destinations[key]
            setActive(next)
            setOpen(true)
          }
        }}
      >
        {current ? (
          <SelectLabel option={current} />
        ) : (
          <span className={styles.placeholder}>{placeholder}</span>
        )}
        <span className={styles.arrow}>
          <IconChevronDownOutline14 />
        </span>
      </button>
      {present
        ? createPortal(
            <div
              ref={floatingRef}
              id={menuId}
              className={styles.menu}
              style={position}
              role="listbox"
              aria-label={ariaLabel}
              data-menu-side={side ?? 'bottom'}
              {...exitProps}
            >
              {options.map((option, index) => (
                <div
                  key={option.value}
                  id={`${menuId}-${index}`}
                  role="option"
                  aria-selected={option.value === value}
                  data-active={shown && active === index}
                  className={styles.option}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(option)}
                >
                  <SelectLabel option={option} />
                  {option.value === value ? <IconCheckOutline16 /> : null}
                </div>
              ))}
            </div>,
            document.body
          )
        : null}
    </>
  )
}

const SelectLabel = ({ option }: { option: SelectOption<string> }) => (
  <span className={styles.label} lang={option.lang}>
    {option.icon ? (
      <span className={styles.icon} aria-hidden="true">
        {option.icon}
      </span>
    ) : null}
    <span>{option.label}</span>
  </span>
)
