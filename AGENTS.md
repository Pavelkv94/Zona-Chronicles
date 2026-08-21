# Project instructions

## Scope

This repository holds the normative design and implementation documentation for «Живая Зона» in `docs/` **and** the executable prototype (`apps/`, `packages/`, `tools/`), bootstrapped in iteration I00.
Do not mark implementation backlog items complete without code and test evidence: a green gate (`pnpm verify`), the recorded Red output that preceded it, and an independent reviewer with zero blocker findings.

The product is an observer-only web experience over a persistent deterministic simulation. Its core hypothesis is that coherent stories emerge from world rules, local knowledge, memory and consequences—not from generated prose.

## Read before changing scope

1. `00_README.md` — project definition and document precedence.
2. `07_MVP_MECHANICS_SPEC.md` — normative mechanics and invariants.
3. `09_EVENT_AND_COMMAND_CONTRACTS.md` — draft executable boundaries.
4. `06_ARCHITECTURE_DECISIONS.md` — accepted ADRs.
5. `10_ITERATION_MASTER_PLAN.md` — implementation order and gates.
6. `11_REQUIREMENTS_TRACEABILITY.md` — requirement-to-test mapping.
7. `12_VISUAL_AND_CONTENT_DESIGN.md` — original visual/content system and atmospheric coverage.
8. `13_WORLD_SYSTEMS_SPEC.md` — normative advanced world mechanics and invariants.

Read the relevant product/simulation document as well. If two files conflict, follow the precedence in `00_README.md` and update every affected downstream document in the same change.

## Non-negotiable product constraints

- The public user is an observer; public APIs do not control the canonical world.
- Canonical state changes only through validated commands/events.
- Replay is deterministic for the same snapshot, seed and rules/content versions.
- Determinism includes immutable rules/content/schema bundle checksums, canonical serialization, numeric/rounding policy and a qualified runtime profile; locale, wall clock, insertion order and DB plan must not change canonical outcomes.
- Facts, agent claims, observer signals and representations are separate layers.
- Knowledge never appears without provenance.
- Text/representation is never a source of canonical facts or state changes.
- The main prototype is complete only after template-only Gate E.
- Until Gate E, do not add runtime LLM SDKs, provider keys/accounts, prompts, embeddings, generation queues or model-specific persistence.
- Utility AI is deterministic application code, not runtime generative AI.
- Coding assistants may be used as development tools; they do not relax the runtime AI restriction.
- Before written IP permission, use only original/neutral content and do not prepare a public S.T.A.L.K.E.R.-branded release.
- Every public asset requires author/source/license/checksum provenance; unknown-source images and game extractions never enter the build.
- Atmospheric content must affect executable mechanics and causal chains; a codex entry, logo or key art alone does not satisfy the requirement.
- Agent instructions are not acceptance evidence. Critical restrictions must be enforced by permissions/sandbox/hooks, lint/import rules, database grants/constraints and CI as defined by ADR-008.
- Observer API, admin/research plane, canonical worker, projections and migrations use least-privilege identities; observer snapshots never expose canonical snapshots or hidden state.

## Change protocol

- Start from observable behavior and a requirement ID from `11_REQUIREMENTS_TRACEABILITY.md`.
- Update product/spec first, then contracts/ADR/master plan/backlog as needed.
- New behavior must name acceptance evidence, invariants and the target iteration/gate.
- Keep open decisions explicit with a decision deadline; do not silently resolve them in implementation prose.
- Do not weaken a gate or threshold merely to make a plan look feasible. Record the reason and before/after evidence.
- Security/operations exceptions require exact scope, owner, compensating control and expiry; blanket or permanent allowlists are not accepted.
- Preserve existing Obsidian wiki links and write project prose in Russian. English technical identifiers are acceptable when they name code/contracts.
- Do not copy proprietary S.T.A.L.K.E.R. names, assets, maps, text or lore into examples.

## Runtime LLM exception

Only I18 after an explicit Gate E **GO** may introduce an optional `narrative` package. It may depend on contracts and read-only projections; core packages must not depend on it. LLM on/off and physical package removal must leave events, snapshots, claims, signals, causal clusters and public IDs unchanged. Failure of I18 means remove/disable the package and keep the template-only product.

## Task isolation

- Every task session runs in its **own git worktree**, created by the lead with `pnpm task:worktree <tasks-map> <task-id>`. The lead installs dependencies there; agents still must not install anything.
- The worktree's diff **is** that session's work. In a shared tree a diff has no author, so a path-ownership verdict describes the tree rather than the session — an innocent session then receives someone else's violation. See findings F5-1, F5-2 and F5-3 in the I00 `REVIEW.md`.
- Each worktree carries its own `.claude/writeset.json`, materialised from the iteration's task map. Declaring an unknown task fails closed: no worktree is created.
- Never edit files that belong to another session's write set, and never revert changes you did not make. Report the conflict to the lead instead — reverting another session's in-flight work destroys it and fixes nothing.

## Claude five-hour usage window

- Requirement DEV-01 (automatic checkpoint, wait and resume across the window) was **withdrawn** on 2026-08-21 by owner decision — see ADR-009 in `06_ARCHITECTURE_DECISIONS.md`. The repository contains no checkpoint/resume machinery and promises no automatic continuation.
- Running out of the window is a technical pause, not task completion, not a product blocker, and not permission to reduce scope or tests.
- Handling the pause belongs to the human and the external runner. Do not claim automatic continuation under any circumstance.
- Do not reintroduce the protocol as a declaration. If autonomous work across the window is needed again, the requirement returns together with real telemetry, wake and resume adapters.
