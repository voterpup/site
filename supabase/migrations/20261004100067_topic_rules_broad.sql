-- the first-screen tiles are broader now ("Healthcare wait times", "Public safety"): the topic guesser knows those words
do $$ declare d text; begin
  d := pg_get_functiondef('vp_guess_topic'::regproc);
  d := replace(d, '(hospitals?|doctors?|clinics?|health|hygiene|', '(hospitals?|doctors?|clinics?|health|healthcare|hygiene|');
  d := replace(d, '(crime|theft|stolen|break.?ins?|unsafe|police|', '(crime|theft|stolen|break.?ins?|unsafe|safety|police|');
  execute d;
end $$;
