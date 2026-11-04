/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The PvP server the landing screen offers by default ("host:port", a bare
   *  host, or a ws:// / wss:// URL). Set at build time, e.g. in .env.local. */
  readonly VITE_SERVER?: string;
}
