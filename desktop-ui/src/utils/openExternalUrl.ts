import { open } from '@tauri-apps/plugin-shell'

export const openExternalUrl = async (url?: string | null) => {
  if (!url) return false
  try {
    await open(url)
    return true
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer')
    return true
  }
}
