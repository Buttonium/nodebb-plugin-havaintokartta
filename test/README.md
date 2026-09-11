# Report concurrency tests

`node --test` runs the controller interleaving tests and existing regressions.
The SQL integration test is optional and reports a skip unless
`HAVAINTOKARTTA_TEST_PGLITE` points to an installed `@electric-sql/pglite`
module. Install it in a separate scratch directory, not as a production plugin
dependency, and set the variable to its absolute module directory before
running `node --test`. This executes the actual SQL with an isolated PostgreSQL
engine and synthetic NodeBB tables; it never uses production credentials.

The CAS implementation targets the PostgreSQL schema and `db.pool` /
`db.objectCache.del` interfaces verified in NodeBB **4.15.2**. Production was
reported as PostgreSQL **17.2-alpine**. The local SQL test does not replace a
staging check on that container. Other database adapters fail closed with 503
for report updates/review/completion rather than using an unsafe fallback.

Deploy all plugin workers together: old workers still contain blind report
writes and must not overlap the new version. Existing records need no migration;
their first conditional save assigns a revision. Confirm edit/review/completion,
public list freshness, and an overlapping edit/review on staging.

Record and report-index writes share one transaction. Files and forum topics
are not transactional: image deletion follows successful commit, while topic
creation can still leave an unlinked topic if its subsequent report-link save
conflicts or fails. Orphan-file cleanup, shared-image reattachment and general
delete-versus-save coordination are separate concerns.
