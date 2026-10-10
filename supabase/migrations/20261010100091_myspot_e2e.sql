-- My spot: personal and private-link memories can be end-to-end encrypted. The server then holds only ciphertext (body and photo);
-- the key lives in the link and on the maker's phone, never on the server. Such a memory can never be made public.
alter table spots add column if not exists enc boolean not null default false;
notify pgrst, 'reload schema';
