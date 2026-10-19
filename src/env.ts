export interface Env {
  DB: D1Database;
  VECTORIZE: VectorizeIndex;
  AI: Ai;
  API_AUTH_TOKEN: string;
  /** Optional comma-separated list of browser origins allowed to call the server. Unset = any. */
  ALLOWED_ORIGINS?: string;
}

export const SERVER_NAME = "remote-mcp-memory";
export const SERVER_VERSION = "1.1.0";
