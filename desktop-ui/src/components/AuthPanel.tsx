import React, { FormEvent, useEffect, useState } from 'react'
import { ArrowRight, Building2, KeyRound, LockKeyhole, Mail, Server, Smartphone, UserRound } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import type { AccountProfileSection } from '../types'
import { authenticateWithPassword, authenticateWithPhoneCode, fetchConsoleSummary, logoutSession, sendPhoneVerificationCode } from '../utils/authApi'
import { getRunModeLabel, getUserDisplayName } from '../utils/accountDisplay'
import { toUserFacingError } from '../utils/userFacingError'
import AccountProfile from './AccountProfile'
import './AuthPanel.css'

type AuthMode = 'login' | 'register'
type LoginMethod = 'email' | 'phone'

interface AuthPanelProps {
  initialProfileSection?: AccountProfileSection
  highlightedAchievementKeys?: string[]
  onInitialProfileSectionHandled?: () => void
}

const AuthPanel: React.FC<AuthPanelProps> = ({
  initialProfileSection,
  highlightedAchievementKeys,
  onInitialProfileSectionHandled,
}) => {
  const {
    apiBaseUrl,
    adminApiBaseUrl,
    authToken,
    authExpiresAt,
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
  const [username, setUsername] = useState('')
  const [nickname, setNickname] = useState('')
  const [companyName, setCompanyName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [phoneCode, setPhoneCode] = useState('')
  const [codeSent, setCodeSent] = useState(false)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [balanceError, setBalanceError] = useState<string | null>(null)

  const refreshBalance = async () => {
    if (!authToken || !currentUser) return
    setBalanceError(null)
    try {
      const summary = await fetchConsoleSummary(adminApiBaseUrl, authToken)
      setCloudBalance(summary.balance ?? null)
      setCloudSubscription(summary.current_subscription ?? null)
    } catch (err) {
      setCloudBalance(null)
      setCloudSubscription(null)
      setBalanceError(toUserFacingError(err, '账户余额读取失败'))
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
        const session = await authenticateWithPhoneCode(
          adminApiBaseUrl,
          phone,
          phoneCode,
          mode === 'register' ? username : undefined,
          mode === 'register' ? nickname : undefined,
          mode === 'register' ? companyName : undefined,
        )
        setAuthSession(session)
        return
      }
      const session = await authenticateWithPassword(
        adminApiBaseUrl,
        mode,
        email,
        password,
        username,
        nickname,
        companyName,
      )
      setAuthSession(session)
    } catch (err) {
      setError(toUserFacingError(err, '登录失败，请检查网络或账户信息'))
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
      setError(toUserFacingError(err, '验证码发送失败'))
    } finally {
      setLoading(false)
    }
  }

  if (currentUser) {
    const accountLabel = getUserDisplayName(currentUser)
    const runModeLabel = getRunModeLabel(currentUser, cloudSubscription)
    return (
      <AccountProfile
        accountLabel={accountLabel}
        adminApiBaseUrl={adminApiBaseUrl}
        apiBaseUrl={apiBaseUrl}
        authToken={authToken!}
        balanceError={balanceError}
        cloudBalance={cloudBalance}
        highlightedAchievementKeys={highlightedAchievementKeys}
        initialSection={initialProfileSection}
        onInitialSectionHandled={onInitialProfileSectionHandled}
        onUserChange={(user) => setAuthSession({
          access_token: authToken!,
          expires_at: authExpiresAt || new Date(Date.now() + 30 * 86400_000).toISOString(),
          user,
        })}
        onLogout={handleLogout}
        runModeLabel={runModeLabel}
        user={currentUser}
      />
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

        {mode === 'register' && (
          <label>
            <span>账户名</span>
            <div className="auth-panel__input-with-icon">
              <UserRound size={16} aria-hidden />
              <input
                autoComplete="username"
                maxLength={30}
                minLength={2}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="用于识别账户，注册后保留展示"
                required
                value={username}
              />
            </div>
          </label>
        )}

        {mode === 'register' && (
          <label>
            <span>昵称</span>
            <div className="auth-panel__input-with-icon">
              <UserRound size={16} aria-hidden />
              <input
                autoComplete="nickname"
                maxLength={30}
                minLength={2}
                onChange={(event) => setNickname(event.target.value)}
                placeholder="用于头像和左下角用户卡片"
                required
                value={nickname}
              />
            </div>
          </label>
        )}

        {mode === 'register' && (
          <label>
            <span>公司名称（可选）</span>
            <div className="auth-panel__input-with-icon">
              <Building2 size={16} aria-hidden />
              <input
                autoComplete="organization"
                maxLength={100}
                onChange={(event) => setCompanyName(event.target.value)}
                placeholder="例如：记忆面包科技"
                value={companyName}
              />
            </div>
          </label>
        )}

        {mode === 'register' && (
          <p className="auth-panel__profile-note">昵称和公司名称注册后仍可修改，每项每个自然月最多 3 次。</p>
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
