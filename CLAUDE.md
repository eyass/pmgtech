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

Two things this does **not** change, because they are about honesty rather than
permission:

- **Report afterwards, plainly.** Irreversible actions get stated in the reply —
  what was merged, what was applied, what would reverse it. Authorisation to act
  without asking is not authorisation to be quiet about it.
- **Say so when something is genuinely destructive or wrong.** Flag it in a
  sentence and carry on with the work; do not withhold the work pending an answer.

Tool-permission prompts from the harness itself are a separate mechanism and
cannot be granted from inside a session — see `/permissions`.

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
