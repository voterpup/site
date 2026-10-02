-- per-device and per-place limits on photo reads (spam and cost guard)
create table if not exists snap_log (id bigserial primary key, dev text not null, lat double precision, lng double precision, ts timestamptz not null default now());
create index if not exists snap_log_dev_ts on snap_log(dev, ts desc);
alter table snap_log enable row level security;
