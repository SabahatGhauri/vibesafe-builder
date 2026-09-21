-- 006: let generation_stats record free-trial builds.
--
-- Why: the free trial runs generations under mode 'starter', which 004's CHECK
-- constraint rejects and lib/adminStats.js filtered out. Every trial build was
-- therefore recorded nowhere, and the owner dashboard's activity chart stayed
-- empty for accounts that only ever used the trial.
--
-- Safe to re-run. Existing rows are untouched: 'byok' and 'managed' stay valid.

alter table generation_stats drop constraint if exists generation_stats_mode_check;
alter table generation_stats
  add constraint generation_stats_mode_check
  check (mode in ('byok', 'managed', 'starter'));
