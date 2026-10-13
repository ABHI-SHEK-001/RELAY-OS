# RelayOS Architecture

## Product Goal

RelayOS is a durable, dependency-aware agentic workflow runtime that plans, executes, verifies, and recovers complex tasks.

Its core differentiator is reliable execution with verifiable outcomes and recovery from partial failures.

## Current Architecture

- `apps/api`: HTTP API and MCP endpoint.
- `packages/core`: Workflow schemas, workflow creation, and core validation.
- `packages/core/src/dag.ts`: Dependency validation and execution ordering.
- `packages/mcp-server`: MCP tools and server construction.
- `packages/storage`: Storage interfaces and PostgreSQL implementation, currently being established.

## Storage Decision

PostgreSQL is the planned persistent database. Storage code will be isolated from workflow logic so that the core engine does not depend directly on database implementation details.

Docker Compose will be used for local database development. Kubernetes deployment will be added after the application and persistence behavior are verified.

## Execution Principles

1. Dependencies must be validated before execution.
2. Cyclic workflows and missing dependencies must be rejected.
3. Independent tasks may execute concurrently within a configured limit.
4. Failed prerequisites must block dependent tasks.
5. Persistent state is the source of truth for execution and recovery.
6. The planner proposes actions; the executor enforces policy.
7. The verifier checks evidence from actual execution.

## Architecture Decisions

- Use a TypeScript monorepo.
- Expose workflow capabilities through an MCP server.
- Keep storage behind a dedicated package boundary.
- Use PostgreSQL for durable state.
- Use deterministic execution and tests before introducing model-driven planning.
- Introduce Kafka and Kubernetes only when their behavior can be tested meaningfully.

## Current Limitations

- Workflow state is currently held in process memory.
- Durable persistence and restart recovery are not yet verified.
- Planner, executor, verifier, policy enforcement, and temporal memory remain future implementation tasks.
- Bedrock runtime integration is not yet verified.

## Change Log

- 2026-10-12: Initial TypeScript monorepo and MCP foundation established.
- 2026-10-13: Update after DAG scheduling and persistence milestones are verified.