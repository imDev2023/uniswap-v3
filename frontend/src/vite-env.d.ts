/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CHAIN_ID?: string
  readonly VITE_RPC_URL?: string
  readonly VITE_FACTORY_ADDRESS?: string
  readonly VITE_GRADUATION_MANAGER_ADDRESS?: string
  readonly VITE_SUBGRAPH_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
