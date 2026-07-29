-- =============================================================================
-- 0019_devexp_squad.sql — DevExp, and the four squads that only existed in the
-- deployed project
-- =============================================================================
--
-- 0001 seeds the four product squads. Four more — devops, product, data,
-- security — were inserted straight into this project afterwards with no
-- migration behind them, so a database rebuilt from the migrations directory
-- came up without them. They are recorded here.
--
-- DevExp is what the platform team is actually called. The 'devops' row was a
-- placeholder nobody had been assigned to, and its description already read
-- "developer experience, platform and delivery infrastructure", so it is
-- renamed rather than duplicated: one squad for that team, not two overlapping
-- ones. Renaming the key is safe because engineers reference squads by id.
--
-- Membership is not seeded here. Engineers arrive from HiBob and their squad is
-- set by hand in the admin screen (squad_source = 'manual', which a later sync
-- will not overwrite); on a fresh database there is nobody to assign yet.

update squads
   set key = 'devexp',
       name = 'DevExp'
 where key = 'devops'
   and not exists (select 1 from squads where key = 'devexp');

insert into squads (key, name, description, colour, sort_order) values
  ('devexp',   'DevExp',   'Developer experience, platform and delivery infrastructure', '#0891b2', 5),
  ('product',  'Product',  'Product and design',                                         '#db2777', 6),
  ('data',     'Data',     'Data engineering and analytics',                             '#65a30d', 7),
  ('security', 'Security', 'Security engineering',                                       '#dc2626', 8)
on conflict (key) do nothing;
