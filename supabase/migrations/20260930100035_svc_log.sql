create table if not exists svc_log (day date not null, svc text not null, calls int not null default 0, primary key (day, svc));
alter table svc_log enable row level security;
grant all on svc_log to service_role;
