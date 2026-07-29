# pmgtech

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
