export const buildAdminConsoleUrl = (adminApiBaseUrl: string): string => {
  try {
    const url = new URL(adminApiBaseUrl)
    const isLocalhost = url.hostname === '127.0.0.1' || url.hostname === 'localhost'
    if (isLocalhost && url.port === '8080') {
      url.port = '3000'
    }
    url.pathname = '/console'
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return 'http://127.0.0.1:3000/console'
  }
}
