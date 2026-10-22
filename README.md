# Pi: agent runtime engineering

A fork of [Pi](https://github.com/earendil-works/pi) maintained by [Artem Polovyi](https://github.com/apolovyi). My work focuses on the runtime behind long-running coding sessions: retaining useful context, recovering from failed compaction and exposing lifecycle state to extensions.

Current fork behavior also includes managed Codex identity/request diagnostics with cached transport-fallback reporting while preserving caller-supplied identity headers, correction-aware summaries with bounded tool-result excerpts and persisted-session recovery references, boolean extension flags that preserve prompts, and graceful timeout cleanup. Upstream owns context accounting, shell PATH ordering, and public compaction events; summaries no longer write duplicate tool-output audit files.

## Preserve context while controlling resource use

Compaction replaces conversation history with a summary that subsequent work depends on. I separated summary-generation budgets from the reserve that determines when compaction starts, and fixed split-turn handling to retain an existing history summary. Changing context headroom no longer implicitly changes the summary's output budget or discards prior context when only a turn prefix needs summarizing.

[Implementation and regression tests](https://github.com/apolovyi/pi/commit/84a587fb1382e18f718cbeca9d0cc28d0fc9acb1).

Current status: upstream owns split-turn summary retention and model-limit summary generation; the fork carries no independent summary-budget settings. In 1.4.0, `reserveTokens` controls only when compaction starts, not summary output length.

## Recover without a permanent cooldown

A failed summarization must not leave a session unable to compact again. I corrected the recovery transitions so an expired cooldown permits another automatic attempt, while successful manual compaction clears the failure state. Failed manual attempts retain the cooldown rather than reporting recovery that did not happen.

[Implementation and recovery tests](https://github.com/apolovyi/pi/commit/750ba73b799f7d31063aa06a8758038155e9b2da).

Current status: the historical cooldown patches are no longer retained; cancellation and continuation use upstream behavior.

## Give extensions an explicit lifecycle contract

Extensions need to distinguish compaction in progress, completion, failure and skipped attempts. I exposed typed start/end events from the session runtime, carrying the reason, result, abort and retry state. Consumers can observe the same lifecycle instead of inferring it from terminal messages.

[Event contract and tests](https://github.com/apolovyi/pi/commit/390d1d8a17822b26f06e66d21372db7c77af4639).

Current status: upstream's `session_before_compact`, `session_compact`, and `session_compact_failed` events replace the private extension bridge. Failures before preparation can have no matching start event.

## Engine regression and current-catalog CI

Engine and environment regression checks use `npm run hydrate:test-model-data` followed by `npm run build:offline`. The fixture at `packages/ai/test/fixtures/model-catalog.json` is the typed model data from the upstream 1.4.0 source archive, verified against SHA-256 `12b14a5d812e049a0b22449e2589ee7647c31f00f93bb97d8d25aff0e71920da` and its model-data manifest. Refresh it with the selected upstream release when updating the fork. It is only a test baseline; normal builds and runtime model discovery still use current catalogs. Engine CI runs the credential-isolated `./test.sh` with Node 22 and Bun 1.4.3; Bun 1.3.14 fails the release's worker-lifetime exit-record tests.

Upstream 1.4.0 includes the Xiaomi `mimo-v2.6-pro` and GitHub Copilot `gpt-6.1-sol` default corrections. Their former fork backports are omitted. The fork retains only managed runtime behavior and independent regression/current-catalog CI; it does not import post-release fixes.

The managed Codex identity uses upstream's client-identity formatting with the `codex_cli` product and compatibility version. Explicit short/custom identity user agents and model/caller identity headers remain supported; the private compatibility-version control header is validated and removed before transport.

The independent **Current model catalog** job runs on pushes, pull requests, manual dispatch, and hourly. Scheduled runs only perform discovery and compatibility checks, not the full engine suite. It uses the existing strict generator, validates and builds against the discovered data, then checks that runtime providers expose every catalog entry and that the defaults selected in `model-resolver.ts` still exist. Missing defaults fail explicitly; unrelated additions and removals are reported without choosing replacement models.

`npm run generate:model-catalog` preloads a discovery-only fetch policy: at most three attempts per request, a 30-second deadline including successful response bodies, and 1-second/2-second backoffs. Only transient transport failures, request deadlines, and HTTP 408/429/500/502/503/504 responses are retried. Permanent HTTP errors, malformed JSON, and compatibility assertions remain failures; no stale catalog is substituted. Normal builds and provider inference do not load this policy.

The job summary and `current-model-catalog` artifact retain additions, removals, metadata changes with before/after values, content hashes, and the captured catalog. Changes are relative to the bundled release fixture, not the previous hourly run. The report is written before building so compatibility failures do not hide discovery evidence. Discovery errors fail the job instead of falling back to stale data. Artifact upload runs only when catalog or report files exist, so discovery failure before producing output does not add a misleading upload failure. These unauthenticated checks do not establish account access or working inference; credential-dependent smoke tests remain separate.

## Project documentation

These changes are implemented in TypeScript with regression tests in the agent-session and compaction suites.

- [Project overview, development and build instructions](https://github.com/apolovyi/pi/blob/main/PROJECT.md).
- [Coding-agent documentation](packages/coding-agent/README.md).
- [Compaction design and settings](packages/coding-agent/docs/compaction.md).
- [Upstream Pi project](https://github.com/earendil-works/pi).
