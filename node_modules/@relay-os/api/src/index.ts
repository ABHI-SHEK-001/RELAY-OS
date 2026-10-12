import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";

import { createRelayMcpServer } from "../../../packages/mcp-server/src/index.js"

const app = createMcpExpressApp();

const mcpHandler = createMcpHandler(() => createRelayMcpServer(), {
  legacy: "reject",
});

const nodeHandler = toNodeHandler(mcpHandler);

app.all("/mcp", (req, res) => {
  void nodeHandler(req, res, req.body);
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "relay-os-api",
  });
});

const port = Number(process.env.PORT ?? 3000);

app.listen(port, () => {
  console.log(`RelayOS API listening on http://localhost:${port}`);
  console.log(`MCP endpoint: http://localhost:${port}/mcp`);
});
