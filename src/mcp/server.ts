import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config } from "../config.js";
import { openDatabase } from "../db/db.js";
import { createMcpServer } from "./tools.js";

// MCP over stdio: for Claude Code on the same machine, or over ssh. The same
// tools are served over HTTP by the web server at /mcp (see mcp/http.ts).
const db = openDatabase(config.databasePath);
const server = createMcpServer(db);
await server.connect(new StdioServerTransport());
console.error(`barista-memory MCP ready (db: ${config.databasePath}, device: ${config.deviceHost})`);
