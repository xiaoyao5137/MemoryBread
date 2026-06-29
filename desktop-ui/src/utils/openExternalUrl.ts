export const openExternalUrl = async (url?: string | null) => {
  if (!url) return false
  window.open(url, '_blank', 'noopener,noreferrer')
  return true
}
