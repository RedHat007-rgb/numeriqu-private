# Engineering Documentation

This directory is the engineering source of truth for how the Numeriqu repository is organized, how the system is designed, and how a new developer should work inside the codebase.

## Recommended reading path

1. [Developer Onboarding](/Users/basanireddy/Desktop/test-1234/docs/developer-onboarding.md)
2. [Repository Structure](/Users/basanireddy/Desktop/test-1234/docs/repository-structure.md)
3. [System Architecture](/Users/basanireddy/Desktop/test-1234/docs/architecture.md)
4. [Development Workflow](/Users/basanireddy/Desktop/test-1234/docs/development-workflow.md)
5. [Database Schema](/Users/basanireddy/Desktop/test-1234/docs/database-schema-numeriqu.md)
6. [Architecture Log](/Users/basanireddy/Desktop/test-1234/docs/architecture-log.md)

## Document map

- `developer-onboarding.md`: first-week guide for engineers joining the project
- `repository-structure.md`: what lives where and why
- `architecture.md`: system/container view, key request flows, and runtime boundaries
- `development-workflow.md`: local setup, commands, engineering expectations, and delivery workflow
- `database-schema-numeriqu.md`: transactional data model and multi-tenant integrity rules
- `architecture-log.md`: historical architecture decisions and migration notes
- `cost-classification.md`: finance-domain reference data used by the product

## Documentation principles

- Prefer updating an existing source-of-truth document over creating one-off notes.
- Keep architecture statements aligned with the running code, not aspirational diagrams.
- Record meaningful design changes in `architecture-log.md` when they affect system behavior, boundaries, or tradeoffs.
