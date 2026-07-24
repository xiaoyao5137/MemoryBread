import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  authenticateWithPassword,
  completeCloudSnapshotUpload,
  fetchCloudDevices,
  fetchCloudSnapshots,
  upsertCloudDevice,
  updateUserProfile,
} from '../utils/authApi'
import { useAppStore } from '../store/useAppStore'

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
})

afterEach(() => {
  vi.restoreAllMocks()
})

beforeEach(() => {
  useAppStore.setState({ serviceEnvironment: 'production' })
})

describe('cloud device and snapshot API', () => {
  it('sends account name, nickname and company when registering with password auth', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      data: {
        access_token: 'mbs_token',
        expires_at: '2026-07-08T00:00:00Z',
        user: {
          id: '018f0000-0000-7000-8000-000000000004',
          username: '烘焙师土豆',
          email: 'tudou@memorybread.local',
          status: 'active',
          roles: ['user'],
          locale: 'zh-CN',
          timezone: 'Asia/Shanghai',
          created_at: '2026-07-07T00:00:00Z',
        },
      },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await authenticateWithPassword(
      'http://127.0.0.1:8080',
      'register',
      'tudou@memorybread.local',
      'MemoryBread@2026!',
      ' 烘焙师土豆 ',
      ' 土豆 ',
      ' 记忆面包科技 ',
    )

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8080/v1/auth/register', {
      method: 'POST',
      headers: {
        'X-MemoryBread-Environment': 'production',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: 'tudou@memorybread.local',
        password: 'MemoryBread@2026!',
        username: '烘焙师土豆',
        nickname: '土豆',
        company_name: '记忆面包科技',
      }),
    })
  })

  it('updates nickname and clears an empty company name', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      data: {
        id: '018f0000-0000-7000-8000-000000000004',
        username: '烘焙师土豆',
        nickname: '小麦',
        company_name: null,
        status: 'active',
        roles: ['user'],
        locale: 'zh-CN',
        timezone: 'Asia/Shanghai',
        created_at: '2026-07-07T00:00:00Z',
      },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await updateUserProfile(
      'http://127.0.0.1:8080',
      'mbs_token',
      ' 小麦 ',
      '  ',
    )

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8080/v1/auth/profile', {
      method: 'PUT',
      headers: {
        'X-MemoryBread-Environment': 'production',
        Authorization: 'Bearer mbs_token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ nickname: '小麦', company_name: undefined }),
    })
  })

  it('explains when the account service does not support profile updates yet', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(null, { status: 404 })))

    await expect(updateUserProfile(
      'http://127.0.0.1:8080',
      'mbs_token',
      '小麦',
    )).rejects.toThrow('账户服务版本较旧，请更新或重启账户服务后重试。')
  })

  it('registers the current device with the account token', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      data: {
        id: 'device-1',
        name: 'MacBook',
        platform: 'macOS',
        client_version: '0.1.0',
        last_seen_at: '2026-07-02T12:00:00Z',
        revoked_at: null,
      },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const device = await upsertCloudDevice('http://127.0.0.1:8080', 'mbs_token', {
      name: 'MacBook',
      platform: 'macOS',
      client_version: '0.1.0',
      public_key_base64: 'cHVibGljLWtleQ==',
    })

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8080/v1/devices', {
      method: 'POST',
      headers: {
        'X-MemoryBread-Environment': 'production',
        Authorization: 'Bearer mbs_token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'MacBook',
        platform: 'macOS',
        client_version: '0.1.0',
        public_key_base64: 'cHVibGljLWtleQ==',
      }),
    })
    expect(device.id).toBe('device-1')
  })

  it('submits encrypted snapshot metadata after upload', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      data: {
        id: 'snapshot-1',
        device_id: 'device-1',
        encrypted_size: 42,
        status: 'committed',
        committed_at: '2026-07-02T12:00:00Z',
      },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const snapshot = await completeCloudSnapshotUpload('http://127.0.0.1:8080', 'mbs_token', {
      device_id: 'device-1',
      encrypted_size: 42,
      oss_object_key: 'snapshots/user/device/file.bin',
      checksum_sha256: 'a'.repeat(64),
      format_version: 1,
      schema_version: 1,
      encryption_version: 1,
    })

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8080/v1/snapshots', expect.objectContaining({
      method: 'POST',
      headers: {
        'X-MemoryBread-Environment': 'production',
        Authorization: 'Bearer mbs_token',
        'Content-Type': 'application/json',
      },
    }))
    expect(snapshot.status).toBe('committed')
  })

  it('reads cloud device and snapshot lists', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 'device-1' }] }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 'snapshot-1' }] }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchCloudDevices('http://127.0.0.1:8080', 'mbs_token')).resolves.toHaveLength(1)
    await expect(fetchCloudSnapshots('http://127.0.0.1:8080', 'mbs_token')).resolves.toHaveLength(1)
    expect(fetchMock).toHaveBeenNthCalledWith(1, 'http://127.0.0.1:8080/v1/devices', {
      headers: {
        'X-MemoryBread-Environment': 'production',
        Authorization: 'Bearer mbs_token',
      },
    })
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:8080/v1/snapshots', {
      headers: {
        'X-MemoryBread-Environment': 'production',
        Authorization: 'Bearer mbs_token',
      },
    })
  })

  it('binds requests to the selected staging environment', async () => {
    useAppStore.setState({ serviceEnvironment: 'staging' })
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ data: [] }))
    vi.stubGlobal('fetch', fetchMock)

    await fetchCloudDevices('http://127.0.0.1:18080', 'mbs_token')

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:18080/v1/devices', {
      headers: {
        'X-MemoryBread-Environment': 'staging',
        Authorization: 'Bearer mbs_token',
      },
    })
  })

  it('maps unready account service errors to user-safe copy', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({
      error: {
        code: 'DATABASE_NOT_CONFIGURED',
        message: '账户服务尚未配置数据库',
      },
    }, 503)))

    await expect(fetchCloudDevices('http://127.0.0.1:8080', 'mbs_token')).rejects.toThrow('账户服务暂时未就绪')
  })
})
