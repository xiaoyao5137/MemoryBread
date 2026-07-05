export interface UserAttachment {
  id: string
  name: string
  type: string
  size: number
  dataUrl: string
}

const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024
const MAX_ATTACHMENTS = 6

const readFileAsDataUrl = (file: File) => new Promise<UserAttachment>((resolve, reject) => {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    reject(new Error(`${file.name} 超过 8MB，暂不支持上传`))
    return
  }

  const reader = new FileReader()
  reader.onload = () => {
    resolve({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      name: file.name || '未命名附件',
      type: file.type || 'application/octet-stream',
      size: file.size,
      dataUrl: String(reader.result || ''),
    })
  }
  reader.onerror = () => reject(new Error(`${file.name || '附件'} 读取失败`))
  reader.readAsDataURL(file)
})

export async function filesToAttachments(files: Iterable<File>, existingCount = 0) {
  const selected = Array.from(files).slice(0, Math.max(0, MAX_ATTACHMENTS - existingCount))
  return Promise.all(selected.map(readFileAsDataUrl))
}

export function formatAttachmentSize(size: number) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

export function buildAttachmentPrompt(attachments: UserAttachment[]) {
  if (!attachments.length) return ''
  return [
    '用户随本次请求附加了以下文件。请结合附件信息回答；如果当前模型无法直接读取图片内容，请明确基于用户指令和可见上下文给出结果，不要声称已经看到了图片细节。',
    ...attachments.map((item, index) => {
      const imageHint = item.type.startsWith('image/') ? `，图片 data URL：${item.dataUrl.slice(0, 180)}...` : ''
      return `${index + 1}. ${item.name}（${item.type || '未知类型'}，${formatAttachmentSize(item.size)}${imageHint}）`
    }),
  ].join('\n')
}

export function buildAttachmentMetadata(attachments: UserAttachment[]) {
  return attachments.map(({ id, name, type, size, dataUrl }) => ({ id, name, type, size, data_url: dataUrl }))
}
