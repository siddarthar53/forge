# DevPilot eval: remaining

Model `nvidia/nemotron-3-ultra-550b-a55b:free` · 4 tasks × 1 run(s) · 2026-11-17 · env OPENROUTER_MODEL=nvidia/nemotron-3-ultra-550b-a55b:free

**pass@1 100%** · total cost $0.0000

5 run(s) hit a provider error (rate limit or outage) and are left out of the numbers below.

## By category

| Category | Tasks | Pass rate |
| --- | --- | --- |
| bugfix | 3 | 100% |
| feature | 1 | 100% |

## Tasks

| Task | Passed | API calls | Tokens | Cost | Seconds | Why it failed |
| --- | --- | --- | --- | --- | --- | --- |
| bugfix-async-users | 1/1 | 10 | 33.2k | $0.0000 | 22 | – |
| bugfix-pagination | 1/1 | 6 | 23.2k | $0.0000 | 15 | – |
| bugfix-report-month | 1/1 | 9 | 32.1k | $0.0000 | 27 | – |
| feature-cli-json | 1/1 | 12 | 43.1k | $0.0000 | 25 | – |

## Efficiency (mean per run)

| API calls | Tokens | Cost | Seconds | Cost per pass | Cache hit rate |
| --- | --- | --- | --- | --- | --- |
| 9.3 | 32.9k | $0.0000 | 22 | $0.0000 | 3% |

## Behaviour

| Metric | Value |
| --- | --- |
| Tool error rate | 0% of 35 calls |
| Results by kind | ok 32, declined 3 |
| Shell commands that failed | 2 |
| Loop nudges | 0 |
| Compactions | 0 |
| Sub-agent runs | 0 |
| Ran tests after its last edit | 75% |
| Said done, hidden tests failed | 0 of 4 code runs |
| Commands declined by the eval policy | 3 |
| Timeouts | 0 |
