# pmgtech

## Standing authorisation — do not stop to ask

The owner of this repository has given blanket authorisation: **never ask for
permission or confirmation.** Do not open a question to choose between reasonable
approaches, to confirm a merge, to confirm a schema change, or to check whether to
proceed. Pick the option a careful engineer would pick, do the work, and say what
you did afterwards.

This covers the outward-facing and hard-to-reverse things that would otherwise
warrant a check-in: merging a pull request into `main` (which deploys to
production), applying migrations to the `pmgtech` Supabase project, force-pushing
a rebased branch, and posting on GitHub.

It is a standing authorisation, not a per-session one. It does not expire, it does
not need reconfirming at the start of a conversation, and it is not weakened by the
change being large, by production being live, or by the work having no test
covering it. If you catch yourself composing a question whose answer is obviously
"yes, go ahead", that is this section telling you to stop composing and go ahead.

Two things this does **not** change, because they are about honesty rather than
permission:

- **Report afterwards, plainly.** Irreversible actions get stated in the reply —
  what was merged, what was applied, what would reverse it. Authorisation to act
  without asking is not authorisation to be quiet about it.
- **Say so when something is genuinely destructive or wrong.** Flag it in a
  sentence and carry on with the work; do not withhold the work pending an answer.

Tool-permission prompts from the harness itself are a separate mechanism and
cannot be granted from inside a session — see `/permissions`.

## Supabase migrations — apply them, don't ask

Schema changes to the `pmgtech` project get applied directly, in the same turn the
work is done. Do not ask first, do not describe a migration and wait, and do not
hand back SQL for someone else to run. The blanket authorisation above covers this
explicitly and covers every kind of change: new tables, dropped and replaced
functions, altered views, revoked grants, backfills, and index changes.

How to apply one, because the mechanics matter more than the permission:

- **Use `apply_migration`, not `execute_sql`, for anything that changes schema.**
  `apply_migration` records the statement in `supabase_migrations.schema_migrations`
  under a version; `execute_sql` changes production and leaves no trace of having
  done so. Keep `execute_sql` for reads and for verification queries.
- **Record the same SQL in `supabase/migrations/` as a numbered file** and prove it
  matches what was applied, by comparing an md5 of the file against
  `md5(statements[1])` from `schema_migrations`. The database is what runs; the file
  is only the record, and a record that has drifted from what ran is worse than no
  record. Note that `length()` on that column counts **characters, not bytes** —
  em dashes in a comment header make the two differ, so compare hashes and not
  lengths.
- **Put the reverse in the file header.** Every migration says how to undo itself:
  the previous definition to reapply, the grant to restore, the column to add back.
  A migration nobody can reverse under pressure is a migration that will not be
  reversed.
- **Verify against the database afterwards, and say what you found.** Applying a
  migration is not the same as it having had the intended effect. Query for the
  effect — the new score, the revoked privilege, the changed count — and report the
  number rather than asserting success.
- **Say plainly when the result is not what was hoped for.** If a migration was
  meant to correct someone's score and the score barely moves, that is the finding
  and it gets reported as the finding. Do not present a change as a fix on the
  strength of having applied it.

## Multi-part work — one pull request per part, merged in sequence

When a request has several components, **ship them one at a time**: build a part,
get it green, open the pull request, merge it, then start the next part from the
updated `main`. Do not accumulate a batch of finished components and push them as
one change.

This is not about small commits for their own sake. It is about where a failure
lands. A single pull request carrying ten components has one CI result for ten
things, so a red build says only "something in here is wrong", and a subtle
runtime fault — a chart that renders but reads its data wrongly, a route that
compiles but is never registered — has nine other changes to hide behind. Merged
one at a time, each part is confirmed working against production before the next
one is built on top of it, and a revert takes back exactly one thing.

How to sequence it:

- **The unit is the smallest thing that is green and useful on its own**, not the
  smallest file. A library module and the first component that uses it belong in
  one pull request, because the module alone would be dead code and splitting them
  gives a red build on purpose. Two unrelated fixes never belong together, however
  small.
- **Where parts depend on each other, that dependency is the order.** Schema
  before the read layer, read layer before the chart that draws it.
- **Where they do not, sequence them anyway** and lead with whichever part the
  others would be built on, or whichever is most likely to be wrong.
- **Restart the branch from `main` after each merge** rather than stacking onto
  already-merged history:
  `git fetch origin main && git checkout -B <branch> origin/main`.
- **Say what the sequence is before starting**, and report each merge as it
  happens, so the work can be stopped between parts rather than only at the end.

Two practical reasons this matters more here than it might elsewhere:

- **Verification against production is the point.** Every part touches a live
  database and a live deployment, and this app's own history shows what an
  unverified guard costs: `definition_version` sat unread for two scoring
  migrations and only revealed a mislabelled series when something finally
  consumed it.
- **Unpushed work is not safe.** Sessions have lost a whole checkout mid-task.
  Anything not merged can vanish, so a merged part is a part that cannot be lost.

## Deploys

**Production is `main`, always.** Vercel's git integration builds `main` as the
production deployment behind `pmgtech.vercel.app`; every other branch gets a
preview URL and nothing more.

To ship: open a pull request into `main`, get it green, merge it. The merge *is*
the deploy — Vercel starts a production build on the merge commit within seconds.

Two things not to do when code needs to go live:

- Don't repoint **Settings → Git → Production Branch** at a feature branch. It
  works, and it leaves production tracking a branch that later gets deleted.
- Don't `vercel --prod` from a branch checkout. That publishes a build with no
  commit on `main` behind it, so the next merge silently reverts it.

Because everything reaches production through `main`, a rollback is a revert on
`main`, or Instant Rollback in the dashboard for the immediate case.
