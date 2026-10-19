import { createMcpHandler } from "@modelcontextprotocol/server";
import { type Env, SERVER_NAME, SERVER_VERSION } from "./env";
import { isAuthorized, isOriginAllowed, jsonResponse, rpcError, withCors } from "./http";
import { createServer } from "./mcp";

export type { Env } from "./env";

const MCP_PATHS = new Set(["/", "/mcp"]);

async function route(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);

  // Unauthenticated liveness probe; reveals nothing beyond name/version.
  if (pathname === "/health") return jsonResponse({ status: "ok", name: SERVER_NAME, version: SERVER_VERSION });
  if (!MCP_PATHS.has(pathname)) return rpcError(404, "Not found");

  if (!(await isAuthorized(request, env.API_AUTH_TOKEN))) {
    return rpcError(401, "Unauthorized", -32001, { "WWW-Authenticate": 'Bearer realm="mcp"' });
  }

  const handler = createMcpHandler(() => createServer(env));
  return handler.fetch(request);
}

// Cloudflare Workers fetch handler
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get("Origin");
    // DNS-rebinding / cross-site protection per the MCP Streamable HTTP spec.
    if (!isOriginAllowed(origin, env)) return rpcError(403, "Origin not allowed");
    if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }), origin);

    let response: Response;
    try {
      response = await route(request, env);
    } catch (err) {
      console.error("Unhandled error", err);
      response = rpcError(500, "Internal error", -32603);
    }
    return withCors(response, origin);
  },
} satisfies ExportedHandler<Env>;