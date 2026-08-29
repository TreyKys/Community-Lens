-- social_posts media consistency.
--
-- WRITTEN BECAUSE THIS SHIPPED BROKEN AND NOBODY NOTICED FOR DAYS.
--
-- 20260807120000 added social_posts_media_consistency_chk, requiring
-- media_kind and media_url to move together. media_kind defaults to 'none',
-- so an insert that sets only the URL now violates it. The planner's insert
-- was written before the constraint existed and set only the URL — so every
-- planner run failed on every market, the queue stayed empty, and the only
-- evidence was a line in a Telegram message.
--
-- The migration and the code that writes to the table were correct
-- separately and wrong together, which is precisely the gap a migration test
-- against real code shapes is for. Each case below is an INSERT SHAPE taken
-- from an actual call site.
\set ON_ERROR_STOP on
\pset pager off

CREATE OR REPLACE FUNCTION pg_temp.check(label text, ok boolean, detail text DEFAULT '')
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok THEN RAISE NOTICE 'PASS  %  %', rpad(label, 56), detail;
  ELSE        RAISE WARNING 'FAIL  %  %', rpad(label, 56), detail;
  END IF;
END$$;

-- The column default, read from the catalogue rather than assumed — if the
-- default ever changes, this test follows it instead of quietly lying.
CREATE OR REPLACE FUNCTION pg_temp.default_media_kind()
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (SELECT btrim(split_part(column_default, '''', 2))
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name='social_posts'
        AND column_name='media_kind'),
    'none');
$$;

-- Does an insert survive the constraint? Returns the error, or NULL for ok.
CREATE OR REPLACE FUNCTION pg_temp.try_insert(p jsonb)
RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.social_posts (channel, kind, body, status, media_kind, media_url, scheduled_at)
  VALUES (
    COALESCE(p->>'channel', 'x'),
    COALESCE(p->>'kind', 'opening_line'),
    COALESCE(p->>'body', 'a post'),
    COALESCE(p->>'status', 'queued'),
    -- Absent media_kind means "the caller did not set it", which is the whole
    -- bug: the column default applies.
    COALESCE(p->>'media_kind', pg_temp.default_media_kind()),
    p->>'media_url',
    now() + interval '1 hour'
  );
  RETURN NULL;
EXCEPTION WHEN check_violation THEN
  RETURN SQLERRM;
END$$;

DO $t$
DECLARE err text;
BEGIN
  PERFORM pg_temp.check('media_kind defaults to none',
    pg_temp.default_media_kind() = 'none', pg_temp.default_media_kind());

  ---------------------------------------------------------------- the bug
  -- The planner's insert AS IT WAS: a URL and no kind. This must be refused,
  -- and this test exists to prove the refusal is real rather than theoretical.
  err := pg_temp.try_insert('{"media_url":"https://x/api/social/card/1"}'::jsonb);
  PERFORM pg_temp.check('a URL with no kind is refused — the shipped bug',
    err IS NOT NULL, COALESCE(left(err, 48), 'ACCEPTED'));

  ---------------------------------------------------------------- the fix
  -- The planner's insert AS IT IS NOW.
  err := pg_temp.try_insert(
    '{"media_kind":"auto_card","media_url":"https://x/api/social/card/1"}'::jsonb);
  PERFORM pg_temp.check('kind + URL together is accepted — the fix',
    err IS NULL, COALESCE(left(err, 60), 'ok'));

  ---------------------------------------------------- the other call sites
  -- /draft (telegram route): neither field set. Relies on the default being
  -- consistent with a NULL url, which it is — but only by luck unless tested.
  err := pg_temp.try_insert('{"kind":"briefed","status":"draft"}'::jsonb);
  PERFORM pg_temp.check('a draft with no image at all is accepted',
    err IS NULL, COALESCE(left(err, 60), 'ok'));

  -- setMedia('none') must genuinely clear the URL. If it left a stale one the
  -- publisher would keep attaching an image the operator had just removed —
  -- which is the reason the constraint exists.
  err := pg_temp.try_insert('{"media_kind":"none","media_url":"https://x/stale.png"}'::jsonb);
  PERFORM pg_temp.check('"no image" cannot keep a stale URL',
    err IS NOT NULL, COALESCE(left(err, 48), 'ACCEPTED'));

  -- setMedia('upload') stores tg:<file_id>, never a URL.
  err := pg_temp.try_insert('{"media_kind":"upload","media_url":"tg:AgACAgQxyz"}'::jsonb);
  PERFORM pg_temp.check('an upload carrying a telegram file id is accepted',
    err IS NULL, COALESCE(left(err, 60), 'ok'));

  err := pg_temp.try_insert('{"media_kind":"upload"}'::jsonb);
  PERFORM pg_temp.check('an upload with no source is refused',
    err IS NOT NULL, COALESCE(left(err, 48), 'ACCEPTED'));

  err := pg_temp.try_insert('{"media_kind":"auto_card"}'::jsonb);
  PERFORM pg_temp.check('an auto_card with no source is refused',
    err IS NOT NULL, COALESCE(left(err, 48), 'ACCEPTED'));

  ---------------------------------------------------------------- kind set
  BEGIN
    INSERT INTO public.social_posts (channel, kind, body, status, media_kind, media_url)
    VALUES ('x','opening_line','b','queued','video','https://x/v.mp4');
    PERFORM pg_temp.check('an unknown media_kind is refused', false, 'ACCEPTED');
  EXCEPTION WHEN check_violation THEN
    PERFORM pg_temp.check('an unknown media_kind is refused', true);
  END;

  ---------------------------------------------------------- what survived
  PERFORM pg_temp.check('exactly the three valid shapes were stored',
    (SELECT count(*) FROM public.social_posts) = 3,
    (SELECT count(*)::text FROM public.social_posts));
  PERFORM pg_temp.check('and every stored row satisfies the invariant',
    NOT EXISTS (
      SELECT 1 FROM public.social_posts
       WHERE (media_kind = 'none') <> (media_url IS NULL)));
END
$t$;
