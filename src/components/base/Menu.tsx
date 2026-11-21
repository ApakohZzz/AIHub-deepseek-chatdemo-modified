import clsx from 'clsx'
import { useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPosition, useDismiss, type Side } from './anchored.js'
import styles from './Menu.module.css'
import { useOverlayPresence } from './useOverlayPresence.js'

export type MenuOption = {
  key: string
  label: string
  icon: ReactNode
  danger?: boolean
  onSelect: () => void
}

/** 点击触发，向下展开；点外部或 Esc 关闭 */
export const Menu = ({
  options,
  children,
  side,
  className,
}: {
  options: MenuOption[]
  children: (props: { open: boolean; toggle: () => void }) => ReactNode
  side?: Side
  className?: string
}) => {
  const [open, setOpen] = useState(false)
  const pendingAction = useRef<(() => void) | null>(null)
  const { content: present, exitProps } = useOverlayPresence(open ? true : null, () => {
    const action = pendingAction.current
    pendingAction.current = null
    action?.()
  })
  const close = () => setOpen(false)
  // 左侧对齐并再左移 5px，让菜单文字与触发元素图标对齐
  const {
    anchorRef,
    floatingRef,
    position,
    side: menuSide,
  } = useAnchoredPosition<HTMLSpanElement, HTMLDivElement>(present !== null, {
    side,
    align: 'start',
    alignOffset: side === 'top' ? 0 : -5,
    offset: side === 'top' ? 8 : 4,
  })
  useDismiss(open, [anchorRef, floatingRef], close, { captureEscape: true })

  return (
    <>
      <span ref={anchorRef} className={styles.anchor}>
        {children({
          open,
          toggle: () => {
            if (!pendingAction.current) setOpen((value) => !value)
          },
        })}
      </span>
      {present
        ? createPortal(
            <div
              ref={floatingRef}
              className={clsx(styles.menu, className)}
              style={position}
              role="menu"
              data-menu-side={menuSide ?? side ?? 'bottom'}
              {...exitProps}
            >
              {options.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  role="menuitem"
                  className={clsx(styles.option, option.danger && styles.danger)}
                  onClick={() => {
                    if (!pendingAction.current) {
                      // 选项可能移动会话或替换触发器，等菜单退场后再执行。
                      pendingAction.current = option.onSelect
                      close()
                    }
                  }}
                >
                  <span className={styles.icon}>{option.icon}</span>
                  {option.label}
                </button>
              ))}
            </div>,
            document.body
          )
        : null}
    </>
  )
}
