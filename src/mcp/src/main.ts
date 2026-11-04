import { createServer } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { MemoiaClient } from "@jianify/memoia";
import { createMemoryServer } from "./server.js";

const { MEMOIA_API_URL, MEMOIA_PROJECT_TOKEN, MEMOIA_USER_ID } = process.env;
if (!MEMOIA_API_URL || !MEMOIA_PROJECT_TOKEN || !MEMOIA_USER_ID)
  throw new Error("Set MEMOIA_API_URL, MEMOIA_PROJECT_TOKEN and MEMOIA_USER_ID explicitly");
if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(MEMOIA_USER_ID)) throw new Error("MEMOIA_USER_ID must be a UUID");
const client = new MemoiaClient({ baseUrl: MEMOIA_API_URL, apiKey: MEMOIA_PROJECT_TOKEN, maxAttempts: 1 });
const transport = process.env.TRANSPORT ?? "sse";
if (transport === "stdio") {
  await createMemoryServer(client, MEMOIA_USER_ID).connect(new StdioServerTransport());
} else if (transport === "sse") {
  const port = Number(process.env.PORT ?? 8000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid local MCP PORT");
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  // This optional local adapter exposes one explicitly configured identity, never arbitrary users.
  const sessions = new Map<string, SSEServerTransport>();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (!hosts.includes(request.headers.host ?? "")) { response.writeHead(403).end(); return; }
    const origin = request.headers.origin;
    if (origin && !/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin)) { response.writeHead(403).end(); return; }
    try {
      if (request.method === "GET" && url.pathname === "/sse") {
        if (sessions.size >= 16) { response.writeHead(503).end(); return; }
        const transport = new SSEServerTransport("/messages", response, { enableDnsRebindingProtection: true, allowedHosts: hosts });
        const mcp = createMemoryServer(client, MEMOIA_USER_ID);
        sessions.set(transport.sessionId, transport);
        response.on("close", () => { sessions.delete(transport.sessionId); void mcp.close(); });
        await mcp.connect(transport);
      } else if (request.method === "POST" && url.pathname === "/messages") {
        const session = sessions.get(url.searchParams.get("sessionId") ?? "");
        if (!session) { response.writeHead(404).end(); return; }
        await session.handlePostMessage(request, response);
      } else response.writeHead(404).end();
    } catch {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  server.listen(port, "127.0.0.1");
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
    server.close();
    for (const session of sessions.values()) void session.close();
  });
} else throw new Error("TRANSPORT must be stdio or sse");
