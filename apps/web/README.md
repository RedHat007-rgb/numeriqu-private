# Web Application

This package contains the main Numeriqu frontend built with Next.js App Router and React.

## Responsibilities

- landing and product marketing surfaces
- login and signup entry points
- authenticated dashboard workspace
- integrations and team-management UI
- messaging, RAG, and agent user interfaces
- frontend transport for cookie-based API communication

## Structure

- `app/`: route tree and page-level composition
- `app/dashboard/`: authenticated product workspace
- `components/`: reusable UI and landing components
- `lib/api/`: typed API wrappers used by the frontend
- `middleware.ts`: route-level auth gating

## Local development

From the repository root:

```bash
pnpm --filter web dev
```

Useful commands:

```bash
pnpm --filter web build
pnpm --filter web lint
pnpm --filter web check-types
```

Default local URL:

- `http://localhost:3001`

## Runtime notes

- the frontend communicates with the backend using cookie-aware requests
- auth state is backend-owned; the UI should not bypass API session rules
- product routes rely on organization-aware backend responses, especially in the dashboard and AI surfaces

## Further reading

- [Developer onboarding](/Users/basanireddy/Desktop/test-1234/docs/developer-onboarding.md)
- [Repository structure](/Users/basanireddy/Desktop/test-1234/docs/repository-structure.md)
- [System architecture](/Users/basanireddy/Desktop/test-1234/docs/architecture.md)
