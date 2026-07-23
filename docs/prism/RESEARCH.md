# Prism Benchmark Research

The research basis, product contract, security model, bounded contexts, and
architecture decisions are maintained in [architecture.md](./architecture.md).

The July 22, 2026 implementation audit established five release blockers:

1. tenant isolation must be enforced on every analytics query;
2. interactive analysis needs bounded execution and cancellation;
3. Prism must be usable at mobile widths and meet accessibility fundamentals;
4. every verified result needs a customer-safe evidence envelope;
5. deployment must be gated by repeatable quality checks.

The recommended approach is a modular monolith with deterministic financial
calculation, typed model planning, registry-owned semantics, structured answers,
and durable workers for long-running workloads. Microservices are deferred until
measured scaling or ownership boundaries justify extraction.

## Primary research used

- [NIST AI Risk Management Framework](https://www.nist.gov/itl/ai-risk-management-framework)
  for governed, measured, and monitored AI risk controls.
- [OWASP Top 10 for LLM Applications](https://owasp.org/www-project-top-10-for-large-language-model-applications/)
  for prompt injection, disclosure, output handling, and excessive-agency threat
  modeling.
- [W3C guidance for complex data tables](https://www.w3.org/WAI/tutorials/tables/)
  for the exact accessible alternative beneath every Prism chart.
- [NestJS queue guidance](https://docs.nestjs.com/techniques/queues) and
  [NestJS caching guidance](https://docs.nestjs.com/techniques/caching) for
  durable workload separation and distributed caching boundaries.
- [OpenAI evaluation guidance](https://platform.openai.com/docs/guides/evals)
  for versioned task, adversarial, and regression evaluations rather than
  informal prompt examples.
