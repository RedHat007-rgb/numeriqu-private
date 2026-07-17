# Product and UX Design

## Product definition

The Signal Intelligence Platform is a finance operations workspace that detects meaningful changes in financial data, explains them with evidence, and turns them into reusable actions.

## Core user pain

- Too much time spent finding the issue before solving it
- Too little trust in AI answers without proof
- Too much one-off analysis that cannot be reused
- Too little collaboration around the same signal

## What the product must do

1. Detect important finance changes before they become incidents.
2. Explain why the change happened with evidence.
3. Let users collaborate around the same signal.
4. Convert investigations into dashboards or board packs.

## Product pillars

- Signal Inbox
- Investigation Workspace
- Board Pack Builder
- Watchlists and Alerts
- Collaboration Layer

## Experience loop

1. Something changed.
2. The system flags it.
3. The user opens the investigation.
4. The system explains the evidence.
5. The user decides what to do.
6. The user exports or resolves the result.

## Information architecture

- Overview
- Signals
- Investigations
- Board Packs
- Watchlists
- Dashboards
- Team
- Settings

## UX rules

- Every signal must lead to an investigation or dismissal.
- Every investigation must lead to a resolution or export path.
- Every error must explain what data is missing.
- Do not show dead-end empty states.
- Do not use fake production-like sample data.

## Accessibility rules

- Visible focus states
- Keyboard-accessible actions
- Semantic headings
- Chart summaries or tables
- Color not used as the only state indicator

## Success metrics

- signal acknowledgement rate
- investigation completion rate
- board pack export rate
- false positive dismissal rate
- alert-to-action conversion

## Related detail docs

- [UX system and layout details](./ux-system.md)
