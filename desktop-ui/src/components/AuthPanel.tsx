import React, { FormEvent, useEffect, useState } from 'react'
import { ArrowRight, CheckCircle2, CreditCard, KeyRound, LogOut, LockKeyhole, Mail, RefreshCw, Server, ShieldCheck, Smartphone, WalletCards } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { authenticateWithPassword, authenticateWithPhoneCode, fetchConsoleSummary, logoutSession, sendPhoneVerificationCode } from '../utils/authApi'
import { getMembershipPlanLabel, getUserDisplayName } from '../utils/accountDisplay'
import { buildAdminConsoleUrl } from '../utils/adminConsole'
import { openExternalUrl } from '../utils/openExternalUrl'
import './AuthPanel.css'

type AuthMode = 'login' | 'register'
type LoginMethod = 'email' | 'phone'

const accountStatusLabel: Record<string, string> = {
  active: '正常',
  suspended: '已暂停',
  deleted: '已注销',
}

const AuthPanel: React.FC = () => {
  const {
    adminApiBaseUrl,
    authToken,
    currentUser,
    cloudBalance,
    cloudSubscription,
    debugModeEnabled,
    setAdminApiBaseUrl,
    setAuthSession,
    setCloudBalance,
    setCloudSubscription,
    clearAuthSession,
  } = useAppStore()
  const [mode, setMode] = useState<AuthMode>('login')
  const [loginMethod, setLoginMethod] = useState<LoginMethod>('email')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [phoneCode, setPhoneCode] = useState('')
  const [codeSent, setCodeSent] = useState(false)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [balanceLoading, setBalanceLoading] = useState(false)
  const [balanceError, setBalanceError] = useState<string | null>(null)

  const refreshBalance = async () => {
    if (!authToken || !currentUser) return
    setBalanceLoading(true)
    setBalanceError(null)
    try {
      const summary = await fetchConsoleSummary(adminApiBaseUrl, authToken)
      setCloudBalance(summary.balance ?? null)
      setCloudSubscription(summary.current_subscription ?? null)
    } catch (err) {
      setCloudBalance(null)
      setCloudSubscription(null)
      setBalanceError(err instanceof Error ? err.message : '钱包信息读取失败')
    } finally {
      setBalanceLoading(false)
    }
  }

  useEffect(() => {
    void refreshBalance()
  }, [authToken, currentUser?.id, adminApiBaseUrl, setCloudBalance, setCloudSubscription])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setLoading(true)
    setError(null)
    try {
      if (loginMethod !== 'email') {
        const session = await authenticateWithPhoneCode(adminApiBaseUrl, phone, phoneCode)
        setAuthSession(session)
        return
      }
      const session = await authenticateWithPassword(adminApiBaseUrl, mode, email, password)
      setAuthSession(session)
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败，请检查网络或账户信息')
    } finally {
      setLoading(false)
    }
  }

  const handleLogout = async () => {
    if (authToken) await logoutSession(adminApiBaseUrl, authToken)
    clearAuthSession()
  }

  const handleSendPhoneCode = async () => {
    setLoading(true)
    setError(null)
    try {
      await sendPhoneVerificationCode(adminApiBaseUrl, phone)
      setCodeSent(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : '验证码发送失败')
    } finally {
      setLoading(false)
    }
  }

  if (currentUser) {
    const accountLabel = getUserDisplayName(currentUser)
    const planLabel = getMembershipPlanLabel(currentUser, cloudSubscription)
    const openBillingConsole = () => {
      void openExternalUrl(buildAdminConsoleUrl(adminApiBaseUrl))
    }
    return (
      <main className="auth-panel auth-panel--signed-in" data-testid="auth-panel">
        <section className="auth-panel__copy">
          <div className="auth-panel__mark">
            <img src="/logo.png" alt="" />
          </div>
          <p className="auth-panel__eyebrow">User account</p>
          <h1>你的账户已经连接。</h1>
          <p className="auth-panel__lead">
            本地记忆继续留在设备上。账户用于管理云能力、Credit、设备和加密快照。
          </p>
          <div className="auth-panel__facts" aria-label="账户边界">
            <span><ShieldCheck size={16} /> 本地优先</span>
            <span><CheckCircle2 size={16} /> {currentUser.roles.includes('platform_admin') ? '平台管理员' : '普通用户'}</span>
            <span><LockKeyhole size={16} /> 登录状态已保存</span>
          </div>
        </section>

        <section className="auth-panel__form" aria-label="用户信息">
          <div className="auth-panel__form-head">
            <span className="auth-panel__form-icon" aria-hidden="true"><CheckCircle2 size={18} /></span>
            <div>
              <strong>用户详情</strong>
              <span>账号、用户资料与钱包信息</span>
            </div>
          </div>
          <div className="auth-panel__avatar-row">
            <span className="auth-panel__avatar" aria-hidden="true">
              {accountLabel.slice(0, 1).toUpperCase()}
            </span>
            <div>
              <strong>{accountLabel}</strong>
              <span>{planLabel} · ID {currentUser.id}</span>
            </div>
          </div>
          <div className="auth-panel__profile">
            <span>会员套餐</span>
            <strong>{planLabel}</strong>
          </div>
          <div className="auth-panel__profile-grid">
            <div><span>角色</span><strong>{currentUser.roles.includes('platform_admin') ? '平台管理员' : '普通用户'}</strong></div>
            <div><span>状态</span><strong>{accountStatusLabel[currentUser.status] ?? '正常'}</strong></div>
            <div><span>区域</span><strong>{currentUser.locale}</strong></div>
            <div><span>时区</span><strong>{currentUser.timezone}</strong></div>
            <div><span>创建时间</span><strong>{new Date(currentUser.created_at).toLocaleString('zh-CN')}</strong></div>
            <div><span>登录方式</span><strong>{currentUser.email ? '邮箱账号' : '手机号账号'}</strong></div>
          </div>
          <div className="auth-panel__wallet">
            <div className="auth-panel__wallet-head">
              <span><WalletCards size={16} aria-hidden /> 钱包信息</span>
              <div className="auth-panel__wallet-actions">
                <button type="button" onClick={openBillingConsole}>
                  <CreditCard size={14} aria-hidden />
                  充值
                </button>
                <button type="button" onClick={refreshBalance} disabled={balanceLoading}>
                  <RefreshCw size={14} aria-hidden className={balanceLoading ? 'spin' : undefined} />
                  刷新
                </button>
              </div>
            </div>
            <div className="auth-panel__wallet-grid">
              <div><span>可用 Credit</span><strong>{cloudBalance?.available ?? '-'}</strong></div>
              <div><span>冻结 Credit</span><strong>{cloudBalance?.reserved ?? '-'}</strong></div>
              <div><span>币种</span><strong>{cloudBalance?.currency ?? 'CREDIT'}</strong></div>
              <div><span>更新时间</span><strong>{cloudBalance?.as_of ? new Date(cloudBalance.as_of).toLocaleString('zh-CN') : '-'}</strong></div>
            </div>
            {balanceError && <div className="auth-panel__wallet-error">{balanceError}</div>}
          </div>
          <button className="auth-panel__submit auth-panel__submit--secondary" type="button" onClick={handleLogout}>
            退出登录 <LogOut size={16} aria-hidden />
          </button>
        </section>
      </main>
    )
  }

  return (
    <main className="auth-panel auth-panel--login" data-testid="auth-panel">
      <form className="auth-panel__form" onSubmit={submit}>
        <div className="auth-panel__form-head">
          <span className="auth-panel__form-icon" aria-hidden="true"><LockKeyhole size={18} /></span>
          <div>
            <strong>登录账户</strong>
            <span>{mode === 'login' ? '使用已有账户登录' : '创建账户后自动登录'}</span>
          </div>
        </div>

        <div className="auth-panel__tabs" role="tablist" aria-label="账户动作">
          <button
            aria-selected={mode === 'login'}
            className={mode === 'login' ? 'auth-panel__tab auth-panel__tab--active' : 'auth-panel__tab'}
            onClick={() => setMode('login')}
            role="tab"
            type="button"
          >
            登录
          </button>
          <button
            aria-selected={mode === 'register'}
            className={mode === 'register' ? 'auth-panel__tab auth-panel__tab--active' : 'auth-panel__tab'}
            onClick={() => {
              setMode('register')
            }}
            role="tab"
            type="button"
          >
            注册
          </button>
        </div>

        <div className="auth-panel__method-tabs" role="tablist" aria-label="登录方式">
          <button
            aria-selected={loginMethod === 'email'}
            className={loginMethod === 'email' ? 'auth-panel__method-tab auth-panel__method-tab--active' : 'auth-panel__method-tab'}
            onClick={() => setLoginMethod('email')}
            role="tab"
            type="button"
          >
            <Mail size={15} aria-hidden />
            邮箱登录
          </button>
          <button
            aria-selected={loginMethod === 'phone'}
            className={loginMethod === 'phone' ? 'auth-panel__method-tab auth-panel__method-tab--active' : 'auth-panel__method-tab'}
            onClick={() => setLoginMethod('phone')}
            role="tab"
            type="button"
          >
            <Smartphone size={15} aria-hidden />
            手机号登录
          </button>
        </div>

        {debugModeEnabled && (
          <label>
            <span>账户连接地址</span>
            <div className="auth-panel__input-with-icon">
              <Server size={16} aria-hidden />
              <input
                onChange={(event) => setAdminApiBaseUrl(event.target.value)}
                value={adminApiBaseUrl}
                spellCheck={false}
              />
            </div>
          </label>
        )}

        {loginMethod === 'email' && (
          <>
            <label>
              <span>邮箱</span>
              <div className="auth-panel__input-with-icon">
                <Mail size={16} aria-hidden />
                <input
                  autoComplete="email"
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@example.com"
                  required
                  type="email"
                  value={email}
                />
              </div>
            </label>
            <label>
              <span>密码</span>
              <div className="auth-panel__input-with-icon">
                <KeyRound size={16} aria-hidden />
                <input
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  minLength={8}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="至少 8 个字符"
                  required
                  type="password"
                  value={password}
                />
              </div>
            </label>
          </>
        )}

        {loginMethod === 'phone' && (
          <>
            <label>
              <span>手机号</span>
              <div className="auth-panel__input-with-icon">
                <Smartphone size={16} aria-hidden />
                <input
                  autoComplete="tel"
                  onChange={(event) => setPhone(event.target.value)}
                  placeholder="请输入手机号"
                  required
                  type="tel"
                  value={phone}
                />
              </div>
            </label>
            <label>
              <span>验证码</span>
              <div className="auth-panel__code-row">
                <div className="auth-panel__input-with-icon">
                  <KeyRound size={16} aria-hidden />
                  <input
                    autoComplete="one-time-code"
                    inputMode="numeric"
                    maxLength={8}
                    onChange={(event) => setPhoneCode(event.target.value)}
                    placeholder={codeSent ? '请输入短信验证码' : '先获取验证码'}
                    required
                    value={phoneCode}
                  />
                </div>
                <button
                  className="auth-panel__code-button"
                  disabled={loading || !phone.trim()}
                  onClick={handleSendPhoneCode}
                  type="button"
                >
                  {codeSent ? '重新发送' : '获取验证码'}
                </button>
              </div>
            </label>
          </>
        )}

        {error && <div className="auth-panel__error" role="alert">{error}</div>}

        <button className="auth-panel__submit" disabled={loading} type="submit">
          {loading ? '登录中...' : mode === 'login' ? '登录' : '注册并登录'}
          <ArrowRight size={16} aria-hidden />
        </button>
      </form>
    </main>
  )
}

export default AuthPanel
