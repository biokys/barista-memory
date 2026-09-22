import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config } from "../config.js";
import { createMcpServer } from "./tools.js";

/**
 * MCP over Streamable HTTP, mounted by the web server at /mcp so a container
 * or an add-on needs no second port. Stateless: every request gets its own
 * server and transport, which is what lets it sit behind a plain HTTP
 * router with no session table.
 *
 * Guarded by a bearer token (GAGGIMATE_MCP_TOKEN). The web UI itself has no
 * login because it only shows data; the MCP can change profiles and switch
 * the machine, so it does not run without one.
 */

function tokenMatches(header: string | undefined): boolean {
  const expected = config.mcpToken;
  if (!expected || !header?.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice(7));
  const want = Buffer.from(expected);
  return given.length === want.length && timingSafeEqual(given, want);
}

export function mcpEnabled(): boolean {
  return config.mcpToken.length > 0;
}

export async function handleMcpRequest(db: DatabaseSync, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!mcpEnabled()) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "MCP_DISABLED", message: "Set GAGGIMATE_MCP_TOKEN to enable the MCP endpoint" }));
    return;
  }
  if (!tokenMatches(req.headers.authorization)) {
    res.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" });
    res.end(JSON.stringify({ error: "UNAUTHORIZED" }));
    return;
  }
  const server = createMcpServer(db);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { void transport.close(); void server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}
