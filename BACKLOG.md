# Maintenance Backlog

## Derived-index v2 lifecycle bounds

1. **Bound page work below 180 seconds.**
   - Evidence: live retrieval currently uses `INDEX_PAGE_LIMIT = 128`, a record-count cutoff rather than a deterministic elapsed-time bound.
   - Acceptance: every v2 page operation completes or returns before 180 seconds, and cursor/checksum resumability remains intact across continuation.

2. **Audit lifecycle operations and maintain scope interfaces.**
   - Acceptance: begin, page, recover, activate, and rollback each create repository-standard audit records and expose maintained scope interfaces.

3. **Prove marker-only recovery against a real isolated engine.**
   - Acceptance: an isolated real-iii-engine integration test demonstrates successful marker-only recovery and records reproducible evidence.

4. **Restore a clean TypeScript check.**
   - Evidence: `pnpm exec tsc --noEmit` currently reports 18 pre-existing diagnostics outside the repaired SDK compatibility files.
   - Acceptance: `pnpm exec tsc --noEmit` exits with zero diagnostics.

Fresh-store use does not require old-corpus migration. These items remain product maintenance debt.
