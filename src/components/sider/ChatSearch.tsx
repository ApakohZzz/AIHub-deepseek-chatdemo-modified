import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'
import { useTranslate } from '../../i18n/index.js'
import { loadSession } from '../../services/chat/db.js'
import {
  CHAT_SEARCH_LIMIT,
  createChatSearchPattern,
  normalizeSearchText,
  searchChatMessages,
  type MessageSearchHit,
  type MessageSearchResult,
} from '../../services/chat/search.js'
import { selectSession, useChatStore } from '../../services/chat/store.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { useSettings } from '../../services/settings.js'
import { formatDate } from '../../utils/format.js'
import { IconButton } from '../base/IconButton.js'
import {
  IconChatOutline16,
  IconCloseOutline16,
  IconPinOutline16,
  IconSearchOutline16,
} from '../base/icons.js'
import { closeMobileSider } from './mobileSiderState.js'
import styles from './ChatSearch.module.css'

const useChatSearch = create(() => ({ open: false }))
export const openChatSearch = () => useChatSearch.setState({ open: true })

export const ChatSearch = () => {
  const open = useChatSearch((state) => state.open)
  return open ? <SearchDialog /> : null
}

type SearchResult = { key: string; session: SessionSummary; message?: MessageSearchHit }
type SearchProgress = MessageSearchResult & {
  pattern: RegExp
  sessions: SessionSummary[]
  done: boolean
}

const Highlight = ({ text, pattern }: { text: string; pattern: RegExp | null }) => {
  const match = pattern?.exec(text)
  if (!match) {
    return text
  }
  return (
    <>
      {text.slice(0, match.index)}
      <mark>{match[0]}</mark>
      {text.slice(match.index + match[0].length)}
    </>
  )
}

const SearchDialog = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const sessions = useChatStore((state) => state.sessions)
  const importing = useChatStore((state) => state.importingHistory)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const selectedResult = useRef<SearchResult | null>(null)
  const resultsId = useId()
  const [query, setQuery] = useState('')
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [closing, setClosing] = useState(false)
  const [progress, setProgress] = useState<SearchProgress | null>(null)
  const keyword = normalizeSearchText(query)
  const pattern = useMemo(() => createChatSearchPattern(keyword), [keyword])
  const expanded = pattern !== null
  const current = progress?.pattern === pattern && progress.sessions === sessions ? progress : null
  const busy = expanded && !current?.done
  const sessionById = useMemo(
    () => new Map(sessions.map((session) => [session.id, session])),
    [sessions]
  )
  const matchingTitles = useMemo(
    () =>
      pattern
        ? sessions.filter((session) =>
            pattern.test(normalizeSearchText(session.title || t('untitledChat')))
          )
        : [],
    [pattern, sessions, t]
  )
  const results: SearchResult[] = []
  for (const message of current?.hits ?? []) {
    const session = sessionById.get(message.sessionId)
    if (session) {
      results.push({
        key: JSON.stringify([message.sessionId, message.messageId]),
        session,
        message,
      })
    }
  }
  results.push(
    ...matchingTitles.slice(0, CHAT_SEARCH_LIMIT).map((session) => ({
      key: `title:${session.id}`,
      session,
    }))
  )
  const index = results.length
    ? Math.max(
        0,
        results.findIndex((result) => result.key === activeKey)
      )
    : -1
  const limited = matchingTitles.length > CHAT_SEARCH_LIMIT || current?.limited
  const timeFormat = useMemo(
    () => new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }),
    [locale]
  )
  const today = formatDate(Date.now())

  useLayoutEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) {
      return
    }
    dialog.showModal()
    inputRef.current?.focus({ preventScroll: true })
    const viewport = window.visualViewport
    const syncViewport = () => {
      if (viewport?.scale === 1) {
        dialog.style.setProperty('--search-viewport-height', `${viewport.height}px`)
        dialog.style.setProperty('--search-viewport-top', `${viewport.offsetTop}px`)
      }
    }
    syncViewport()
    viewport?.addEventListener('resize', syncViewport)
    viewport?.addEventListener('scroll', syncViewport)
    return () => {
      viewport?.removeEventListener('resize', syncViewport)
      viewport?.removeEventListener('scroll', syncViewport)
      dialog.close()
    }
  }, [])

  useEffect(() => {
    if (!pattern || closing || importing) {
      return
    }
    const controller = new AbortController()
    const report = (result: MessageSearchResult, done: boolean) => {
      if (!controller.signal.aborted) {
        setProgress({ ...result, pattern, sessions, done })
      }
    }
    const timer = window.setTimeout(() => {
      const cache = useChatStore.getState().sessionCache
      void searchChatMessages(
        sessions.map(({ id }) => id),
        pattern,
        (id) => (Object.hasOwn(cache, id) ? Promise.resolve(cache[id]) : loadSession(id)),
        controller.signal,
        (result) => report(result, false)
      )
        .then((result) => report(result, true))
        .catch(() => {
          if (!controller.signal.aborted) {
            setProgress((previous) => ({
              pattern,
              sessions,
              hits:
                previous?.pattern === pattern && previous.sessions === sessions
                  ? previous.hits
                  : [],
              limited: false,
              failed: true,
              done: true,
            }))
          }
        })
    }, 120)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [pattern, sessions, closing, importing])

  useEffect(() => {
    if (!closing) {
      return
    }
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const timer = window.setTimeout(
      () => {
        // 原生弹窗先归还焦点，再滚动到命中消息，避免输入框的焦点抢回滚动位置。
        dialogRef.current?.close()
        const result = selectedResult.current
        if (result) {
          selectSession(result.session.id, result.message?.messageId)
          closeMobileSider()
        }
        useChatSearch.setState({ open: false })
      },
      reduced ? 0 : 120
    )
    return () => window.clearTimeout(timer)
  }, [closing])

  const close = () => setClosing(true)
  const select = (result: SearchResult) => {
    if (closing || importing) {
      return
    }
    selectedResult.current = result
    close()
  }

  const updateQuery = (text: string) => {
    setQuery(text)
    setActiveKey(null)
    listRef.current?.scrollTo({ top: 0 })
  }

  const status = busy
    ? t('searchingChats')
    : current?.failed
      ? t(results.length ? 'searchMessagesPartial' : 'searchMessagesFailed')
      : limited
        ? t('searchResultsLimited')
        : t('searchResultsCount', { count: results.length })

  return createPortal(
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-label={t('searchChats')}
      data-closing={closing}
      data-expanded={expanded}
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          close()
        }
      }}
    >
      <div className={styles.panel}>
        <div className={styles.header}>
          <span className={styles.searchIcon}>
            <IconSearchOutline16 />
          </span>
          <input
            ref={inputRef}
            className={styles.input}
            aria-label={t('searchChats')}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={expanded}
            aria-controls={resultsId}
            aria-activedescendant={index >= 0 ? `${resultsId}-${index}` : undefined}
            autoComplete="off"
            placeholder={t('searchChatsPlaceholder')}
            value={query}
            onChange={(event) => updateQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || closing || importing || !results.length) {
                return
              }
              if (event.key === 'Enter') {
                event.preventDefault()
                select(results[index])
              } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                const next =
                  (index + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length
                setActiveKey(results[next].key)
                document
                  .getElementById(`${resultsId}-${next}`)
                  ?.scrollIntoView({ block: 'nearest' })
              }
            }}
          />
          <span className={styles.closeGroup}>
            <IconButton icon={<IconCloseOutline16 />} aria-label={t('close')} onClick={close} />
          </span>
        </div>
        <div className={styles.disclosure} aria-hidden={!expanded}>
          <div className={styles.resultsClip}>
            <div className={styles.resultsBody}>
              <div
                ref={listRef}
                id={resultsId}
                className={styles.results}
                role="listbox"
                aria-label={t('searchChats')}
                aria-busy={busy}
              >
                {results.map((result, row) => {
                  const { session, message } = result
                  const title = normalizeSearchText(session.title || t('untitledChat'))
                  const timestamp = message?.time ?? session.updatedAt
                  const day = formatDate(timestamp)
                  return (
                    <button
                      id={`${resultsId}-${row}`}
                      key={result.key}
                      type="button"
                      role="option"
                      aria-selected={row === index}
                      tabIndex={-1}
                      className={styles.result}
                      onPointerMove={() => setActiveKey(result.key)}
                      onClick={() => select(result)}
                    >
                      <span className={styles.resultIcon}>
                        {session.pinned && !message ? <IconPinOutline16 /> : <IconChatOutline16 />}
                      </span>
                      <span className={styles.resultBody}>
                        <span className={styles.resultHeading}>
                          <span className={styles.resultTitle}>
                            <Highlight text={title} pattern={pattern} />
                          </span>
                          {day ? (
                            <time className={styles.date}>
                              {day === today ? timeFormat.format(timestamp) : day}
                            </time>
                          ) : null}
                        </span>
                        {message ? (
                          <span className={styles.snippet}>
                            <Highlight text={message.snippet} pattern={pattern} />
                          </span>
                        ) : null}
                      </span>
                    </button>
                  )
                })}
                {busy && (
                  <div className={styles.loading} aria-hidden="true">
                    <span className={styles.loadingIcon} />
                    <span className={styles.loadingText} />
                  </div>
                )}
                {!busy && !results.length && expanded && (
                  <p className={styles.empty}>
                    {t(current?.failed ? 'searchMessagesFailed' : 'noSearchResults')}
                  </p>
                )}
              </div>
              <div className={styles.footer}>
                <span role="status">{expanded ? status : ''}</span>
                <span className={styles.shortcuts} aria-hidden="true">
                  <kbd>↑ ↓</kbd> {t('searchNavigationHint')} <kbd>↵</kbd> {t('searchOpenHint')}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </dialog>,
    document.body
  )
}
