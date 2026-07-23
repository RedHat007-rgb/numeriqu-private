# Prism Operations

## Deployable processes

- `api`: interactive, read-only Prism analysis and job submission.
- `prism-worker`: durable briefing workload processor, started with
  `pnpm --filter api start:prism-worker` after the API package is built.
- PostgreSQL: Prism job ledger and transactional outbox.
- Redis: shared answer cache; the API degrades to a bounded process cache when
  Redis is unavailable without weakening tenant isolation.

## Required rollout order

1. Apply `20260722000100_prism_jobs_outbox` to PostgreSQL. It includes the job,
   outbox, action-proposal, and approval-event ledgers.
2. Deploy API instances with the environment controls in `apps/api/.env.example`.
3. Deploy at least two independently supervised Prism worker replicas.
4. Configure alerts for failed jobs, oldest queued-job age, runtime availability,
   average latency, cache failure rate, reconciliation failures, and output-policy
   refusals.
5. Enable ClickHouse row policies only after validating the session-setting
   canary described in the architecture document.

## Correctness and recovery

- Cache identities include organization, capability, period, semantic version,
  and source watermark. A new successful sync naturally invalidates old answers.
- Job submission requires an idempotency key and creates the job plus outbox event
  in one PostgreSQL transaction.
- Action proposals are preview-only. A second user must approve or reject; Prism
  does not execute an approved proposal in this release.
- Workers claim jobs with `FOR UPDATE SKIP LOCKED`, allowing horizontal scale
  without duplicate ownership.
- Failed briefing jobs contain a stable error code, never raw source or provider
  details. Operators may requeue only after diagnosing the upstream condition.

## Release gates

Run `pnpm --filter api qa:prism`, `pnpm check-types`, and `pnpm build`. The GitHub
quality workflow runs the full API suite and production builds before deployment.
