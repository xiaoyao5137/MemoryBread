import React, { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, Bell, Check, LogIn, RefreshCw } from 'lucide-react'
import type { CloudMessage, CloudUser, WindowMode } from '../types'
import { useAppStore } from '../store/useAppStore'
import {
  fetchCloudMessages,
  markAllCloudMessagesRead,
  markCloudMessageRead,
} from '../utils/authApi'
import { openExternalUrl } from '../utils/openExternalUrl'
import './MessagePanel.css'

type LoadState = 'idle' | 'loading' | 'ready' | 'empty' | 'error'

interface MessagePanelProps {
  adminApiBaseUrl?: string
  authToken?: string | null
  currentUser?: CloudUser | null
  embedded?: boolean
  hidden?: boolean
  id?: string
  labelledBy?: string
}

interface MessageCacheEntry {
  items: CloudMessage[]
  unreadCount: number
}

const messagePageCache = new Map<string, MessageCacheEntry>()

const internalMessageModes: Record<string, WindowMode> = {
  account: 'account',
  diary: 'diary',
  messages: 'messages',
  tasks: 'tasks',
}

const categoryLabel: Record<CloudMessage['category'], string> = {
  system: '系统',
  product: '产品',
  account: '账户',
  task: '任务',
}

const priorityLabel: Record<CloudMessage['priority'], string> = {
  normal: '',
  important: '重要',
  urgent: '紧急',
}

const MessagePanel: React.FC<MessagePanelProps> = ({
  adminApiBaseUrl: requestedAdminApiBaseUrl,
  authToken: requestedAuthToken,
  currentUser: requestedCurrentUser,
  embedded = false,
  hidden = false,
  id,
  labelledBy,
}) => {
  const accountState = useAppStore()
  const adminApiBaseUrl = requestedAdminApiBaseUrl ?? accountState.adminApiBaseUrl
  const authToken = requestedAuthToken !== undefined ? requestedAuthToken : accountState.authToken
  const currentUser = requestedCurrentUser !== undefined ? requestedCurrentUser : accountState.currentUser
  const { setWindowMode } = accountState
  const cacheKey = `${adminApiBaseUrl.replace(/\/+$/, '')}:${currentUser?.id ?? 'signed-out'}`
  const cachedPage = messagePageCache.get(cacheKey)
  const [messages, setMessages] = useState<CloudMessage[]>(() => cachedPage?.items ?? [])
  const [unreadCount, setUnreadCount] = useState(() => cachedPage?.unreadCount ?? 0)
  const [state, setState] = useState<LoadState>(() => (
    cachedPage ? (cachedPage.items.length ? 'ready' : 'empty') : 'idle'
  ))
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const hasLoadedRef = useRef(Boolean(cachedPage))
  const requestVersionRef = useRef(0)

  const loadMessages = useCallback(async () => {
    if (!authToken) {
      setMessages([])
      setUnreadCount(0)
      setState('idle')
      return
    }
    const requestVersion = requestVersionRef.current + 1
    requestVersionRef.current = requestVersion
    if (hasLoadedRef.current) {
      setRefreshing(true)
    } else {
      setState('loading')
    }
    setError('')
    try {
      const page = await fetchCloudMessages(adminApiBaseUrl, authToken, { pageSize: 50 })
      if (requestVersion !== requestVersionRef.current) return
      hasLoadedRef.current = true
      setMessages(page.items)
      setUnreadCount(page.unread_count)
      setState(page.items.length ? 'ready' : 'empty')
    } catch (loadError) {
      if (requestVersion !== requestVersionRef.current) return
      setError(loadError instanceof Error ? loadError.message : '消息服务暂时不可用')
      if (!hasLoadedRef.current) setState('error')
    } finally {
      if (requestVersion === requestVersionRef.current) setRefreshing(false)
    }
  }, [adminApiBaseUrl, authToken])

  useEffect(() => {
    void loadMessages()
    return () => {
      requestVersionRef.current += 1
    }
  }, [loadMessages])

  useEffect(() => {
    if (!authToken || !currentUser || !hasLoadedRef.current) return
    messagePageCache.set(cacheKey, {
      items: messages,
      unreadCount,
    })
  }, [authToken, cacheKey, currentUser, messages, unreadCount])

  useEffect(() => {
    if (!authToken) return
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void loadMessages()
    }
    document.addEventListener('visibilitychange', refreshWhenVisible)
    const interval = window.setInterval(refreshWhenVisible, 60_000)
    return () => {
      document.removeEventListener('visibilitychange', refreshWhenVisible)
      window.clearInterval(interval)
    }
  }, [authToken, loadMessages])

  const markRead = async (message: CloudMessage) => {
    if (!authToken || message.read_at || busyId) return
    setBusyId(message.id)
    setError('')
    try {
      const next = await markCloudMessageRead(adminApiBaseUrl, authToken, message.id)
      setMessages(items => items.map(item => item.id === next.id ? next : item))
      setUnreadCount(count => Math.max(0, count - 1))
    } catch (readError) {
      setError(readError instanceof Error ? readError.message : '标记消息失败')
    } finally {
      setBusyId(null)
    }
  }

  const markAllRead = async () => {
    if (!authToken || unreadCount === 0 || busyId) return
    setBusyId('all')
    setError('')
    try {
      const result = await markAllCloudMessagesRead(adminApiBaseUrl, authToken)
      setMessages(items => items.map(item => ({
        ...item,
        read_at: item.read_at || result.read_at,
      })))
      setUnreadCount(0)
    } catch (readError) {
      setError(readError instanceof Error ? readError.message : '标记全部消息失败')
    } finally {
      setBusyId(null)
    }
  }

  const openAction = async (message: CloudMessage) => {
    if (!message.read_at) await markRead(message)
    const actionUrl = message.action_url
    if (!actionUrl) return
    if (actionUrl.startsWith('memorybread://')) {
      const destination = actionUrl.slice('memorybread://'.length).split(/[/?#]/)[0]
      const mode = internalMessageModes[destination]
      if (mode) setWindowMode(mode)
      return
    }
    const target = actionUrl.startsWith('/')
      ? `${adminApiBaseUrl.replace(/\/+$/, '')}${actionUrl}`
      : actionUrl
    await openExternalUrl(target)
  }

  if (!authToken || !currentUser) {
    return (
      <section
        aria-labelledby={labelledBy}
        className={`message-panel${embedded ? ' message-panel--embedded' : ''}`}
        hidden={hidden}
        id={id}
        role={embedded ? 'tabpanel' : undefined}
      >
        <div className="message-panel__state">
          <LogIn size={34} aria-hidden="true" />
          <strong>登录后查看消息</strong>
          <p>产品更新、账户提醒和任务消息会同步到你的收件箱。</p>
          <button type="button" onClick={() => setWindowMode('account')}>打开账户</button>
        </div>
      </section>
    )
  }

  return (
    <section
      aria-busy={state === 'loading' || refreshing}
      aria-labelledby={labelledBy}
      className={`message-panel${embedded ? ' message-panel--embedded' : ''}`}
      hidden={hidden}
      id={id}
      role={embedded ? 'tabpanel' : undefined}
    >
      <header className="message-panel__header">
        <div className="message-panel__summary">
          <strong>{unreadCount}</strong>
          <span>未读</span>
          <button type="button" onClick={markAllRead} disabled={unreadCount === 0 || Boolean(busyId)}>
            <Check size={15} aria-hidden="true" />
            全部已读
          </button>
          <button aria-label="刷新消息" type="button" onClick={loadMessages} disabled={state === 'loading' || refreshing}>
            <RefreshCw className={state === 'loading' || refreshing ? 'spin' : ''} size={15} aria-hidden="true" />
          </button>
        </div>
      </header>

      <span aria-live="polite" className="message-panel__live-status">
        {refreshing ? '正在后台刷新消息' : ''}
      </span>
      {error && state !== 'error' && <div className="message-panel__inline-error" role="status">{error}</div>}
      {(state === 'idle' || state === 'loading') && (
        <div aria-label="正在读取消息" className="message-panel__skeleton" role="status">
          {[0, 1, 2].map(index => (
            <div className="message-panel__skeleton-row" key={index}>
              <span />
              <div><i /><strong /><p /></div>
            </div>
          ))}
        </div>
      )}
      {state === 'error' && (
        <div className="message-panel__state"><AlertCircle size={34} aria-hidden="true" /><strong>消息暂时不可用</strong><p>{error}</p><button type="button" onClick={loadMessages}>重试</button></div>
      )}
      {state === 'empty' && (
        <div className="message-panel__state"><Bell size={34} aria-hidden="true" /><strong>暂时没有消息</strong></div>
      )}
      {state === 'ready' && (
        <div className="message-panel__list">
          {messages.map(message => (
            <article className={message.read_at ? '' : 'message-panel__item--unread'} key={message.id}>
              <button
                aria-label={`标记《${message.title}》为已读`}
                className="message-panel__read-dot"
                disabled={Boolean(message.read_at) || busyId === message.id}
                onClick={() => markRead(message)}
                type="button"
              >
                <span aria-hidden="true" />
              </button>
              <div className="message-panel__copy">
                <div>
                  <span>{categoryLabel[message.category]}{priorityLabel[message.priority] ? ` · ${priorityLabel[message.priority]}` : ''}</span>
                  <time dateTime={message.published_at}>{new Date(message.published_at).toLocaleString('zh-CN')}</time>
                </div>
                <h2>{message.title}</h2>
                <p>{message.body}</p>
                {message.action_label && message.action_url && (
                  <button className="message-panel__action" onClick={() => openAction(message)} type="button">
                    {message.action_label}
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}

export default MessagePanel
