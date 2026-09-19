# Pi: agent runtime engineering

A fork of [Pi](https://github.com/earendil-works/pi) maintained by [Artem Polovyi](https://github.com/apolovyi). My work focuses on the runtime behind long-running coding sessions: retaining useful context, recovering from failed compaction and exposing lifecycle state to extensions.

## Preserve context while controlling resource use

Compaction replaces conversation history with a summary that subsequent work depends on. I separated summary-generation budgets from the reserve that determines when compaction starts, and fixed split-turn handling to retain an existing history summary. Changing context headroom no longer implicitly changes the summary's output budget or discards prior context when only a turn prefix needs summarizing.

[Implementation and regression tests](https://github.com/apolovyi/pi/commit/84a587fb1382e18f718cbeca9d0cc28d0fc9acb1).

## Recover without a permanent cooldown

A failed summarization must not leave a session unable to compact again. I corrected the recovery transitions so an expired cooldown permits another automatic attempt, while successful manual compaction clears the failure state. Failed manual attempts retain the cooldown rather than reporting recovery that did not happen.

[Implementation and recovery tests](https://github.com/apolovyi/pi/commit/750ba73b799f7d31063aa06a8758038155e9b2da).

## Give extensions an explicit lifecycle contract

Extensions need to distinguish compaction in progress, completion, failure and skipped attempts. I exposed typed start/end events from the session runtime, carrying the reason, result, abort and retry state. Consumers can observe the same lifecycle instead of inferring it from terminal messages.

[Event contract and tests](https://github.com/apolovyi/pi/commit/390d1d8a17822b26f06e66d21372db7c77af4639).

## Project documentation

These changes are implemented in TypeScript with regression tests in the agent-session and compaction suites.

- [Project overview, development and build instructions](https://github.com/apolovyi/pi/blob/main/PROJECT.md).
- [Coding-agent documentation](packages/coding-agent/README.md).
- [Compaction design and settings](packages/coding-agent/docs/compaction.md).
- [Upstream Pi project](https://github.com/earendil-works/pi).
