-- the seal edge function runs as service_role; tables made by migrations need the grant explicitly in this project
grant all on table seals to service_role;
grant usage, select, update on sequence seals_id_seq to service_role;
revoke all on table seals from anon, authenticated;
notify pgrst, 'reload schema';
