/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
  readonly VITE_ENABLE_DEV_MOCK_AUTH?: string;
  readonly VITE_APP_NAME?: string;
  readonly VITE_DEFAULT_LOCALE?: string;
  readonly VITE_DEFAULT_CURRENCY?: string;
  readonly VITE_SIGNING_AGENT_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
