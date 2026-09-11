-- Admin control: retag an Open Market's event_tag after the fact.
--
-- event_tag is purely a display-routing hook (which hub page, if any, shows
-- this market — see 20260807030000_open_markets_event_tag.sql) with no
-- money or trading implication, so unlike reschedule/delete this needs
-- almost no validation and works in ANY status, including before approval.
--
-- Added because the create forms only ever SET event_tag once, at
-- submission, and a market submitted without it (the hub chip is an easy
-- extra step to miss) previously had no way to be fixed short of raw SQL —
-- it would sit forever visible only at /open, never on the hub its category
-- actually belongs to.
CREATE OR REPLACE FUNCTION public.admin_retag_open_market(
  p_market_id uuid,
  p_admin_id  uuid,
  p_event_tag text        -- NULL or '' clears it
)
RETURNS TABLE (applied boolean, reason text, event_tag text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mkt public.open_markets%ROWTYPE;
  v_tag text;
BEGIN
  IF p_admin_id IS NULL THEN
    RETURN QUERY SELECT false, 'Admin identity required', NULL::text; RETURN;
  END IF;

  SELECT * INTO v_mkt FROM public.open_markets WHERE id = p_market_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'Market not found', NULL::text; RETURN;
  END IF;

  -- Same normalisation submit_open_market already applies to this column:
  -- lowercased, blank collapses to NULL rather than an empty string that
  -- would silently fail every `.eq('event_tag', ...)` hub query.
  v_tag := NULLIF(lower(btrim(COALESCE(p_event_tag, ''))), '');

  IF v_tag IS NOT DISTINCT FROM v_mkt.event_tag THEN
    RETURN QUERY SELECT true, 'unchanged', v_mkt.event_tag; RETURN;
  END IF;

  INSERT INTO public.treasury_log (type, amount_tngn, user_id, open_market_id, metadata)
  VALUES ('admin_alert', 0, NULL, p_market_id, jsonb_build_object(
    'action', 'open_market_retagged',
    'admin_id', p_admin_id,
    'previous_event_tag', v_mkt.event_tag,
    'new_event_tag', v_tag
  ));

  UPDATE public.open_markets SET event_tag = v_tag WHERE id = p_market_id;

  RETURN QUERY SELECT true, 'retagged', v_tag;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_retag_open_market(uuid,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_retag_open_market(uuid,uuid,text) TO service_role;

NOTIFY pgrst, 'reload schema';
