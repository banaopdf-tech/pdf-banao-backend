-- PDF Banao — admin reporting migration (2026-09-26)
-- New admin RPCs for the extended admin panel: revenue, orders, failed-payment
-- recovery, users, funnel, UTM, new-vs-returning. Plus paywall tracking.
-- Every admin function checks pb_admin_ok(p_token) itself, same as the
-- existing pb_admin_stats / pb_admin_tools_get. Amounts are in paise.

-- ----------------------------------------------------------------------
-- 0) paywall tracking: pb_track now also accepts kind = 'paywall'
--    (the backend /t route and pb-pay.js send it when the paywall shows)
-- ----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pb_track(p jsonb, p_ip text, p_ua text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare v text;
begin
  if coalesce(p->>'kind', '') not in ('page', 'tool', 'paywall') then return; end if;
  select encode(hmac(coalesce(p_ip, '') || '|' || coalesce(p_ua, '') || '|' ||
                     to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM-DD'), salt, 'sha256'), 'hex')
    into v from pb_secret where id = 1;
  insert into pb_visits (kind, path, tool, entry, src, ref_host, utm_source, utm_medium, utm_campaign,
                         country, region, city, device, browser, os, lang, screen, visitor)
  values (p->>'kind', left(p->>'path', 200), left(p->>'tool', 60),
          coalesce(p->>'entry', 'false') = 'true',
          left(p->>'src', 60), left(p->>'ref_host', 120),
          left(p->>'utm_source', 80), left(p->>'utm_medium', 80), left(p->>'utm_campaign', 80),
          case when p->>'country' ~ '^[A-Z]{2}$' then p->>'country' end,
          left(p->>'region', 80), left(p->>'city', 80),
          case when p->>'device' in ('mobile', 'tablet', 'desktop') then p->>'device' end,
          left(p->>'browser', 40), left(p->>'os', 40), left(p->>'lang', 20),
          case when p->>'screen' ~ '^[0-9]{2,5}x[0-9]{2,5}$' then p->>'screen' end,
          left(v, 20));
end $function$;

-- ----------------------------------------------------------------------
-- 1) revenue dashboard
-- ----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pb_admin_revenue(p_token text, p_from timestamp with time zone,
  p_to timestamp with time zone, p_tz text DEFAULT 'Asia/Kolkata'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
begin
  if not pb_admin_ok(p_token) then return jsonb_build_object('error', 'auth'); end if;
  if p_to <= p_from or p_to - p_from > interval '400 days' then return jsonb_build_object('error', 'range'); end if;
  return jsonb_build_object(
    'totals', (select jsonb_build_object(
                 'revenue', coalesce(sum(amount), 0),
                 'paid_orders', count(*),
                 'all_orders', (select count(*) from pb_orders where created_at >= p_from and created_at < p_to),
                 'avg_order', coalesce(round(avg(amount)), 0))
               from pb_orders where status = 'paid' and paid_at >= p_from and paid_at < p_to),
    'by_day', (select coalesce(jsonb_agg(jsonb_build_object(
                 'day', d, 'revenue', revenue, 'orders', orders) order by d), '[]'::jsonb)
               from (select (paid_at at time zone p_tz)::date d, sum(amount) revenue, count(*) orders
                     from pb_orders where status = 'paid' and paid_at >= p_from and paid_at < p_to
                     group by 1) s),
    'by_tool', (select coalesce(jsonb_agg(jsonb_build_object(
                 'tool', tool, 'revenue', revenue, 'orders', orders) order by revenue desc), '[]'::jsonb)
               from (select tool, sum(amount) revenue, count(*) orders
                     from pb_orders where status = 'paid' and paid_at >= p_from and paid_at < p_to
                     group by tool) s),
    'by_kind', (select coalesce(jsonb_agg(jsonb_build_object(
                 'kind', kind, 'period', period, 'revenue', revenue, 'orders', orders)
                 order by revenue desc), '[]'::jsonb)
               from (select kind, period, sum(amount) revenue, count(*) orders
                     from pb_orders where status = 'paid' and paid_at >= p_from and paid_at < p_to
                     group by kind, period) s)
  );
end $function$;

-- ----------------------------------------------------------------------
-- 2) orders list (p_status: 'all' | 'paid' | 'pending')
-- ----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pb_admin_orders(p_token text, p_from timestamp with time zone,
  p_to timestamp with time zone, p_status text DEFAULT 'all'::text, p_q text DEFAULT ''::text,
  p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare q text;
begin
  if not pb_admin_ok(p_token) then return jsonb_build_object('error', 'auth'); end if;
  if p_to <= p_from or p_to - p_from > interval '400 days' then return jsonb_build_object('error', 'range'); end if;
  p_limit := least(greatest(coalesce(p_limit, 50), 1), 200);
  p_offset := greatest(coalesce(p_offset, 0), 0);
  q := lower(trim(coalesce(p_q, '')));
  return jsonb_build_object(
    'total', (select count(*)
              from pb_orders o left join pb_users u on u.id = o.user_id
              where o.created_at >= p_from and o.created_at < p_to
                and (p_status = 'all'
                     or (p_status = 'paid' and o.status = 'paid')
                     or (p_status = 'pending' and o.status <> 'paid'))
                and (q = ''
                     or lower(coalesce(u.email, '')) like '%' || q || '%'
                     or lower(coalesce(u.name, '')) like '%' || q || '%'
                     or lower(coalesce(u.mobile, '')) like '%' || q || '%'
                     or lower(coalesce(o.order_id, '')) like '%' || q || '%'
                     or lower(coalesce(o.payment_id, '')) like '%' || q || '%'
                     or lower(coalesce(o.receipt, '')) like '%' || q || '%'
                     or lower(coalesce(o.tool, '')) like '%' || q || '%')),
    'orders', (select coalesce(jsonb_agg(x order by (x->>'created_at') desc), '[]'::jsonb)
              from (select jsonb_build_object(
                       'receipt', o.receipt, 'order_id', o.order_id, 'payment_id', o.payment_id,
                       'tool', o.tool, 'kind', o.kind, 'period', o.period, 'amount', o.amount,
                       'status', o.status, 'created_at', o.created_at, 'paid_at', o.paid_at,
                       'name', u.name, 'email', u.email, 'mobile', u.mobile) as x
                    from pb_orders o left join pb_users u on u.id = o.user_id
                    where o.created_at >= p_from and o.created_at < p_to
                      and (p_status = 'all'
                           or (p_status = 'paid' and o.status = 'paid')
                           or (p_status = 'pending' and o.status <> 'paid'))
                      and (q = ''
                           or lower(coalesce(u.email, '')) like '%' || q || '%'
                           or lower(coalesce(u.name, '')) like '%' || q || '%'
                           or lower(coalesce(u.mobile, '')) like '%' || q || '%'
                           or lower(coalesce(o.order_id, '')) like '%' || q || '%'
                           or lower(coalesce(o.payment_id, '')) like '%' || q || '%'
                           or lower(coalesce(o.receipt, '')) like '%' || q || '%'
                           or lower(coalesce(o.tool, '')) like '%' || q || '%')
                    order by o.created_at desc limit p_limit offset p_offset) s)
  );
end $function$;

-- ----------------------------------------------------------------------
-- 3) failed / abandoned payments (recovery list)
-- ----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pb_admin_recover(p_token text, p_from timestamp with time zone,
  p_to timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
begin
  if not pb_admin_ok(p_token) then return jsonb_build_object('error', 'auth'); end if;
  if p_to <= p_from or p_to - p_from > interval '400 days' then return jsonb_build_object('error', 'range'); end if;
  return jsonb_build_object(
    'total', (select count(*) from pb_orders
              where status <> 'paid' and created_at >= p_from and created_at < p_to),
    'amount', (select coalesce(sum(amount), 0) from pb_orders
               where status <> 'paid' and created_at >= p_from and created_at < p_to),
    'orders', (select coalesce(jsonb_agg(x order by (x->>'created_at') desc), '[]'::jsonb)
               from (select jsonb_build_object(
                        'receipt', o.receipt, 'order_id', o.order_id, 'tool', o.tool,
                        'kind', o.kind, 'period', o.period, 'amount', o.amount,
                        'status', o.status, 'created_at', o.created_at,
                        'stage', case when o.order_id is null then 'created' else 'checkout' end,
                        'age_hours', round(extract(epoch from (now() - o.created_at)) / 3600),
                        'name', u.name, 'email', u.email, 'mobile', u.mobile) as x
                     from pb_orders o left join pb_users u on u.id = o.user_id
                     where o.status <> 'paid' and o.created_at >= p_from and o.created_at < p_to
                     order by o.created_at desc limit 200) s)
  );
end $function$;

-- ----------------------------------------------------------------------
-- 4) registered users + passes
-- ----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pb_admin_users(p_token text, p_q text DEFAULT ''::text,
  p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare q text;
begin
  if not pb_admin_ok(p_token) then return jsonb_build_object('error', 'auth'); end if;
  p_limit := least(greatest(coalesce(p_limit, 50), 1), 200);
  p_offset := greatest(coalesce(p_offset, 0), 0);
  q := lower(trim(coalesce(p_q, '')));
  return jsonb_build_object(
    'total', (select count(*) from pb_users u
              where q = ''
                 or lower(coalesce(u.email, '')) like '%' || q || '%'
                 or lower(coalesce(u.name, '')) like '%' || q || '%'
                 or lower(coalesce(u.mobile, '')) like '%' || q || '%'),
    'active_passes', (select count(distinct user_id) from pb_subs where ends is null or ends > now()),
    'expiring_7d', (select count(*) from pb_subs
                    where ends > now() and ends < now() + interval '7 days'),
    'users', (select coalesce(jsonb_agg(x order by (x->>'created_at') desc), '[]'::jsonb)
              from (select jsonb_build_object(
                       'id', u.id, 'name', u.name, 'email', u.email, 'mobile', u.mobile,
                       'created_at', u.created_at,
                       'orders', (select count(*) from pb_orders o where o.user_id = u.id),
                       'spent', (select coalesce(sum(o.amount), 0) from pb_orders o
                                 where o.user_id = u.id and o.status = 'paid'),
                       'subs', pb_active_subs(u.id)) as x
                    from pb_users u
                    where q = ''
                       or lower(coalesce(u.email, '')) like '%' || q || '%'
                       or lower(coalesce(u.name, '')) like '%' || q || '%'
                       or lower(coalesce(u.mobile, '')) like '%' || q || '%'
                    order by u.created_at desc limit p_limit offset p_offset) s)
  );
end $function$;

-- ----------------------------------------------------------------------
-- 5) funnel: tool open -> paywall -> order -> payment (per tool)
-- ----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pb_admin_funnel(p_token text, p_from timestamp with time zone,
  p_to timestamp with time zone, p_tz text DEFAULT 'Asia/Kolkata'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
begin
  if not pb_admin_ok(p_token) then return jsonb_build_object('error', 'auth'); end if;
  if p_to <= p_from or p_to - p_from > interval '400 days' then return jsonb_build_object('error', 'range'); end if;
  return jsonb_build_object(
    'tools', (select coalesce(jsonb_agg(jsonb_build_object(
                 'tool', tool, 'opens', opens, 'paywalls', paywalls,
                 'orders', orders, 'paid', paid) order by opens desc), '[]'::jsonb)
              from (
                select t.tool,
                       (select count(*) from pb_visits v
                        where v.kind = 'tool' and v.tool = t.tool and v.ts >= p_from and v.ts < p_to) as opens,
                       (select count(*) from pb_visits v
                        where v.kind = 'paywall' and v.tool = t.tool and v.ts >= p_from and v.ts < p_to) as paywalls,
                       (select count(*) from pb_orders o
                        where o.tool = t.tool and o.created_at >= p_from and o.created_at < p_to) as orders,
                       (select count(*) from pb_orders o
                        where o.tool = t.tool and o.status = 'paid'
                          and o.created_at >= p_from and o.created_at < p_to) as paid
                from (select distinct tool from pb_visits where kind in ('tool', 'paywall')
                        and ts >= p_from and ts < p_to and tool is not null
                      union
                      select distinct tool from pb_orders
                        where created_at >= p_from and created_at < p_to and tool is not null) t
              ) s),
    'totals', (select jsonb_build_object(
                 'opens', count(*) filter (where kind = 'tool'),
                 'paywalls', count(*) filter (where kind = 'paywall'))
               from pb_visits where kind in ('tool', 'paywall') and ts >= p_from and ts < p_to)
  );
end $function$;

-- ----------------------------------------------------------------------
-- 6) UTM campaign report
-- ----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pb_admin_utm(p_token text, p_from timestamp with time zone,
  p_to timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
begin
  if not pb_admin_ok(p_token) then return jsonb_build_object('error', 'auth'); end if;
  if p_to <= p_from or p_to - p_from > interval '400 days' then return jsonb_build_object('error', 'range'); end if;
  return jsonb_build_object(
    'campaigns', (select coalesce(jsonb_agg(jsonb_build_object(
                   'utm_source', utm_source, 'utm_medium', utm_medium, 'utm_campaign', utm_campaign,
                   'visits', visits, 'visitors', visitors,
                   'tool_opens', tool_opens, 'paywalls', paywalls)
                   order by visits desc), '[]'::jsonb)
                 from (select coalesce(nullif(utm_source, ''), '(none)') utm_source,
                              coalesce(nullif(utm_medium, ''), '(none)') utm_medium,
                              coalesce(nullif(utm_campaign, ''), '(none)') utm_campaign,
                              count(*) visits,
                              count(distinct visitor) visitors,
                              count(*) filter (where kind = 'tool') tool_opens,
                              count(*) filter (where kind = 'paywall') paywalls
                       from pb_visits
                       where ts >= p_from and ts < p_to
                         and (coalesce(utm_source, '') <> '' or coalesce(utm_medium, '') <> ''
                              or coalesce(utm_campaign, '') <> '')
                       group by 1, 2, 3) s)
  );
end $function$;

-- ----------------------------------------------------------------------
-- 7) new vs returning visitors
-- ----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pb_admin_growth(p_token text, p_from timestamp with time zone,
  p_to timestamp with time zone, p_tz text DEFAULT 'Asia/Kolkata'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare b date := (p_from at time zone p_tz)::date;
begin
  if not pb_admin_ok(p_token) then return jsonb_build_object('error', 'auth'); end if;
  if p_to <= p_from or p_to - p_from > interval '400 days' then return jsonb_build_object('error', 'range'); end if;
  return (
    with in_range as (
      select visitor, (ts at time zone p_tz)::date d
      from pb_visits
      where ts >= p_from and ts < p_to and visitor is not null and kind = 'page'
    ),
    before as (
      select distinct visitor from pb_visits where ts < p_from and visitor is not null
    )
    select jsonb_build_object(
      'totals', (select jsonb_build_object(
                   'visitors', count(distinct visitor),
                   'new_visitors', count(distinct visitor)
                                    filter (where visitor not in (select visitor from before)),
                   'returning', count(distinct visitor)
                                  filter (where visitor in (select visitor from before)))
                 from in_range),
      'by_day', (select coalesce(jsonb_agg(jsonb_build_object(
                   'day', d, 'visitors', visitors,
                   'new_visitors', new_visitors, 'returning', ret)
                   order by d), '[]'::jsonb)
                 from (select d,
                              count(distinct visitor) visitors,
                              count(distinct visitor)
                                filter (where visitor not in (select visitor from before)) new_visitors,
                              count(distinct visitor)
                                filter (where visitor in (select visitor from before)) ret
                       from in_range group by d) s)
    )
  );
end $function$;
