import type { Env } from "./env";

const ALLOW_HEADERS =
  "Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Mcp-Method, Mcp-Name, Last-Event-ID";
const EXPOSE_HEADERS = "Mcp-Session-Id, Mcp-Protocol-Version, Mcp-Method, Mcp-Name, WWW-Authenticate";
const encoder = new TextEncoder();

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

/** JSON-RPC shaped error so MCP clients can surface a readable message. */
export function rpcError(status: number, message: string, code = -32000, headers?: Record<string, string>): Response {
  return jsonResponse({ jsonrpc: "2.0", error: { code, message }, id: null }, status, headers);
}

/** Requests without an Origin (non-browser clients) are always allowed; browsers are checked against ALLOWED_ORIGINS. */
export function isOriginAllowed(origin: string | null, env: Env): boolean {
  if (!origin || !env.ALLOWED_ORIGINS) return true;
  return env.ALLOWED_ORIGINS.split(",").some((o) => o.trim() === origin);
}

export function withCors(response: Response, origin: string | null): Response {
  if (!origin) return response;
  const res = new Response(response.body, response); // clone so headers are mutable
  res.headers.set("Access-Control-Allow-Origin", origin);
  res.headers.set("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", ALLOW_HEADERS);
  res.headers.set("Access-Control-Expose-Headers", EXPOSE_HEADERS);
  res.headers.set("Access-Control-Max-Age", "86400");
  res.headers.append("Vary", "Origin");
  return res;
}

const sha256 = (value: string) => crypto.subtle.digest("SHA-256", encoder.encode(value));

/**
 * Constant-time Bearer token check. Both sides are hashed first so the comparison
 * is fixed-length and leaks neither content nor length via timing. Fails closed if the secret is unset.
 */
export async function isAuthorized(request: Request, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get("Authorization") ?? "");
  if (!match) return false;
  const [given, expected] = await Promise.all([sha256(match[1]), sha256(token)]);
  return crypto.subtle.timingSafeEqual(given, expected);
}
