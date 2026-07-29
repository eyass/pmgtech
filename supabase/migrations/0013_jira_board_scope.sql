-- =============================================================================
-- 0013_jira_board_scope.sql — which Jira boards may drive squad metrics
-- =============================================================================
-- Two problems surfaced on the first real Jira sync.
--
-- 1. A board owned by a project that is not in JIRA_PROJECT_KEYS was synced. Jira's
--    /board endpoint accepts projectKeyOrId but answers with every board that
--    *contains issues from* that project, and a board's filter can span projects. So
--    asking for ten keys returned a Marketing board as well. The board's own project
--    is location.projectKey, and that is what the sync now filters on.
--
-- 2. Several boards are one person's view of a project — "Petra's personal board",
--    "Mehmet's board" — and should not carry sprint metrics for a squad even though
--    their project should.
--
-- jira_boards.is_tracked already existed (0003_jira.sql) and the sprint loop already
-- honoured it; nothing ever set it. This migration only supplies the pattern list
-- that decides it, and the sync fills it in from there.

insert into app_settings (key, value) values
  ('jira_ignored_board_patterns', '["personal board","''s board","''s personal board"]'::jsonb)
on conflict (key) do nothing;

comment on column jira_boards.is_tracked is
  'False for boards excluded from squad attribution and sprint sync — personal boards, and anything matching app_settings.jira_ignored_board_patterns. Rows are kept rather than deleted so a later sync does not recreate them as tracked.';
