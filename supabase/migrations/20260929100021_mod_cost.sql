-- Photo checks are capped by money spent per day, not by count
alter table mod_log add column if not exists cost_usd numeric(10,4) not null default 0;
