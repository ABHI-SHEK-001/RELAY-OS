
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  createWorkflow,
  listWorkflows,
} from "@relay-os/core";

export function createRelayMcpServer() {
  const server = new McpServer({
    name: "relay-os",
    version: "0.1.0",
  });

  server.registerTool(
    "relay_ping",
    {
      description: "Check whether the RelayOS MCP server is responding.",
      inputSchema: {
        message: z.string().optional(),
      },
    },
    async ({ message }) => ({
      content: [
        {
          type: "text",
          text: `RelayOS MCP is alive. ${message ?? "Hello!"}`,
        },
      ],
    }),
  );

  server.registerTool(
    "create_workflow",
    {
      description:
        "Create a workflow containing tasks and their dependencies.",
      inputSchema: {
        name: z.string().min(1),
        tasks: z.array(
          z.object({
            id: z.string().min(1),
            name: z.string().min(1),
            dependencies: z.array(z.string()).default([]),
          }),
        ).min(1),
      },
    },
    async ({ name, tasks }) => {
      try {
        const workflow = createWorkflow({ name, tasks });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(workflow, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: error instanceof Error
                ? error.message
                : "Workflow creation failed.",
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    "list_workflows",
    {
      description: "List workflows stored in the current server process.",
    },
    async () => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(listWorkflows(), null, 2),
        },
      ],
    }),
  );

  return server;
}
