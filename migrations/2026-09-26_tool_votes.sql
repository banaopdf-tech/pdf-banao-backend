-- PDF Banao — tool votes migration (2026-09-26)
-- "Was this tool helpful?" ratings: one row per vote, daily visitor hash for
-- dedupe analysis (same visitor-code method as pb_track). Admin reads the
-- per-tool totals through pb_admin_votes.

-- ----------------------------------------------------------------------
-- 1) votes table
-- ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pb_votes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tool text NOT NULL,
  vote text NOT NULL CHECK (vote IN ('up', 'down')),
  visitor text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pb_votes_tool_idx ON public.pb_votes (tool);

-- ----------------------------------------------------------------------
-- 2) record a vote (called by the backend /t route)
-- ----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pb_vote(p jsonb, p_ip text, p_ua text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare v text;
begin
  if coalesce(p->>'tool', '') !~ '^[a-z0-9-]{1,60}$' then return; end if;
  if coalesce(p->>'vote', '') not in ('up', 'down') then return; end if;
  select encode(hmac(coalesce(p_ip, '') || '|' || coalesce(p_ua, '') || '|' ||
                     to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM-DD'), salt, 'sha256'), 'hex')
    into v from pb_secret where id = 1;
  insert into pb_votes (tool, vote, visitor)
  values (p->>'tool', p->>'vote', left(v, 20));
end $function$;

-- ----------------------------------------------------------------------
-- 3) admin: per-tool vote totals
-- ----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pb_admin_votes(p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
begin
  if not pb_admin_ok(p_token) then return jsonb_build_object('error', 'auth'); end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
             'tool', tool,
             'up', up, 'down', down, 'total', total)
           order by total desc), '[]'::jsonb)
          from (select tool,
                       count(*) filter (where vote = 'up')::int up,
                       count(*) filter (where vote = 'down')::int down,
                       count(*)::int total
                from pb_votes
                group by tool) s);
end $function$;
