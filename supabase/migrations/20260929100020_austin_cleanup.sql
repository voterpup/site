-- One-off cleanup after a forced re-run: same Austin ballot questions saved twice under different wording.
delete from elections where region = 'austin' and kind = 'decision' and vote_date = date '2026-11-03'
  and (name like 'Austin parks and library bond propositions%' or name like 'Austin city charter amendments (Props C%');
-- The country's office is shown in every US city: national authority, not a state page.
update jurisdictions set office_label = 'Vote.gov', office_url = 'https://vote.gov/'
  where level = 'federal' and region = 'united states';
