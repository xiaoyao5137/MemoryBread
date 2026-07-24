/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MEMORYBREAD_DEBUG_MODE?: string
  readonly VITE_MEMORYBREAD_PRODUCTION_ADMIN_API_BASE_URL?: string
  readonly VITE_MEMORYBREAD_PRODUCTION_GATEWAY_API_BASE_URL?: string
  readonly VITE_MEMORYBREAD_STAGING_ADMIN_API_BASE_URL?: string
  readonly VITE_MEMORYBREAD_STAGING_GATEWAY_API_BASE_URL?: string
  /** Legacy production endpoint name. */
  readonly VITE_MEMORYBREAD_ADMIN_API_BASE_URL?: string
  /** Legacy production endpoint name. */
  readonly VITE_MEMORYBREAD_GATEWAY_API_BASE_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
