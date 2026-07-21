# RSS Budget and Compression Parsing Design

## Scope

- Merge `v0.9.28` into `main` while preserving the OpenAI OAuth changelog entry.
- Prevent a process that remains above the 512 MiB RSS budget from reporting healthy.
- Avoid degrading health for a single transient RSS sample.
- Accept compression XML returned in markdown wrappers, conversational pre/postamble, or HTML-escaped form.

## RSS Budget Monitor

- Health samples continue at the existing 30-second interval.
- The monitor tracks consecutive samples with RSS above 512 MiB.
- Two consecutive breaches trigger a single optional `global.gc()` request when Node exposes it.
- The next sample evaluates whether RSS recovered.
- Health is degraded while RSS exceeds the budget.
- Three consecutive post-GC breaches escalate health to critical.
- If GC is unavailable, the monitor records that fact and follows the same sustained-breach escalation without attempting GC.
- The monitor does not restart or terminate the process.

## Compression Parsing

- Normalize an LLM response before extracting compression fields.
- Remove markdown XML fences and surrounding prose.
- Decode HTML-escaped tag delimiters before parsing.
- Preserve the existing required `type` and `title` validation.

## Verification

- Add deterministic tests for RSS steady state, breach persistence, GC availability, recovery, and escalation.
- Add compression tests for fenced, prose-wrapped, and HTML-escaped XML.
- Run focused Vitest suites, the full unit suite, type checking, and the production build.
