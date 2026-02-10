# Logistics-Catalog

This repo includes a practical **AI agent starter** that orchestrates:

- **DeepSea Coder APIs** for code-heavy generation
- **OpenAI GPT APIs** for planning and non-code reasoning
- **Replit APIs** for optional execution/verification steps

## What was fixed in this debug pass

- Added retry + timeout handling for all API requests.
- Added stronger config validation (including URL checks).
- Made Replit credentials optional unless execution is explicitly enabled.
- Improved plan parsing so the agent still works if the planner returns bullets instead of numbered steps.
- Added CLI goal input so you can run custom goals without editing code.

## Files

- `agent-starter.js`: orchestrator with provider routing, retries, planning, execution loop
- `.env.example`: complete env template with optional Replit execution flags

## Quick start

```bash
npm install axios dotenv
cp .env.example .env
node agent-starter.js "Build an AI coding assistant with DeepSea + GPT + Replit"
```

## Enable Replit execution step

By default, Replit execution is **off**.

1. Set:
   - `EXECUTE_REPLIT_STEP=true`
   - `REPLIT_API_KEY`
   - `REPLIT_BASE_URL`
   - `REPLIT_REPL_ID`
2. Re-run `node agent-starter.js`.

## Behavior summary

1. GPT creates a short execution plan.
2. Steps are parsed (numbered or bullets).
3. Each step is routed:
   - DeepSea Coder for implementation/code tasks
   - GPT for operational/reasoning tasks
4. Optional Replit verification command is run if enabled.

## Production hardening checklist

- Add response schema validation (e.g., zod/ajv) for planner and executor outputs.
- Add idempotency keys and request IDs for observability.
- Replace placeholder API routes with your provider-specific endpoints.
- Add policy checks before executing model-proposed commands.
- Add integration tests with mocked provider responses.
