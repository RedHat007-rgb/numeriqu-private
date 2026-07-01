# API Service

This package contains the Numeriqu backend API built with NestJS.

## Responsibilities

- issue and validate auth/session flows
- resolve organization context and enforce permissions
- manage provider integrations and sync orchestration
- expose analytics, dashboard, messaging, RAG, and agent endpoints
- persist operational and audit-relevant metadata in Postgres
- query analytical finance data from ClickHouse where appropriate

## Key module areas

- `src/modules/auth`: OTP, session, invite, and auth endpoints
- `src/modules/org-context`: membership and organization scope enforcement
- `src/modules/analytics`: analytics-facing endpoints
- `src/modules/dashboard`: dashboard CRUD and sharing
- `src/modules/messaging`: organization-scoped messaging
- `src/modules/rag`: retrieval-oriented AI chat
- `src/modules/agent`: dashboard-generation and finance-question agent flows
- `src/modules/audit`: admin-facing audit feed
- `src/integrations`: provider and sync orchestration

## Local development

From the repository root:

```bash
pnpm --filter api dev
```

Useful commands:

```bash
pnpm --filter api build
pnpm --filter api test
pnpm --filter api test:e2e
pnpm --filter api qa
pnpm --filter api qa:browser
```

## Dependencies

The service expects working configuration for:

- Supabase Auth
- Postgres
- Redis
- ClickHouse
- Resend
- an LLM provider
- provider-specific credentials when testing integrations

See [`.env.example`](/Users/basanireddy/Desktop/test-1234/.env.example) and [docs/development-workflow.md](/Users/basanireddy/Desktop/test-1234/docs/development-workflow.md).

## Further reading

- [System architecture](/Users/basanireddy/Desktop/test-1234/docs/architecture.md)
- [Database schema](/Users/basanireddy/Desktop/test-1234/docs/database-schema-numeriqu.md)
- [Agent architecture](/Users/basanireddy/Desktop/test-1234/apps/api/src/modules/agent/AGENT_ARCHITECTURE.md)
