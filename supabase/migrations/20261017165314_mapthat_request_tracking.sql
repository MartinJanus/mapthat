-- Backend-only persistence. No captions, raw Instagram IDs, or Places content.
create table public.extraction_requests (
  id uuid primary key,
  account_ref text not null check (account_ref ~ '^[a-f0-9]{64}$'),
  message_ref text not null check (message_ref ~ '^[a-f0-9]{64}$'),
  sender_ref text not null check (sender_ref ~ '^[a-f0-9]{64}$'),
  reel_ref text check (reel_ref ~ '^[a-f0-9]{64}$'),
  status text not null default 'processing'
    check (status in ('processing', 'completed', 'partial', 'no_places', 'failed', 'unsupported')),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  duration_ms integer check (duration_ms >= 0),
  replies_sent integer not null default 0 check (replies_sent >= 0),
  replies_failed integer not null default 0 check (replies_failed >= 0),
  unique (account_ref, message_ref),
  check ((status = 'processing' and completed_at is null) or
         (status <> 'processing' and completed_at is not null))
);
create index extraction_requests_created_at_idx on public.extraction_requests (created_at desc);
create index extraction_requests_sender_created_idx on public.extraction_requests (sender_ref, created_at desc);
create index extraction_requests_reel_idx on public.extraction_requests (reel_ref) where reel_ref is not null;

create table public.places (
  google_place_id text primary key check (length(google_place_id) between 1 and 255),
  created_at timestamptz not null default now()
);
create table public.request_places (
  request_id uuid not null references public.extraction_requests(id) on delete cascade,
  ordinal integer not null check (ordinal >= 0),
  google_place_id text references public.places(google_place_id),
  mention_name text not null check (length(mention_name) between 1 and 500),
  city text check (length(city) <= 500),
  country text check (length(country) <= 500),
  match_kind text not null check (match_kind in ('matched', 'no-photo', 'ambiguous', 'not-found', 'unavailable', 'unconfigured')),
  confidence text check (confidence in ('high', 'medium', 'possible')),
  photo_available boolean not null,
  primary key (request_id, ordinal),
  check ((match_kind in ('matched', 'no-photo') and google_place_id is not null and confidence is not null)
      or (match_kind not in ('matched', 'no-photo') and google_place_id is null and confidence is null))
);
create index request_places_place_idx on public.request_places (google_place_id);

create table public.provider_usage (
  id uuid primary key,
  request_id uuid not null references public.extraction_requests(id) on delete cascade,
  provider text not null check (provider in ('gemini', 'google_places')),
  operation text not null check (operation in ('caption', 'video', 'search', 'photo')),
  model text,
  succeeded boolean not null,
  http_status integer check (http_status between 100 and 599),
  duration_ms integer not null check (duration_ms >= 0),
  input_tokens integer check (input_tokens >= 0),
  output_tokens integer check (output_tokens >= 0),
  cached_tokens integer check (cached_tokens >= 0),
  thought_tokens integer check (thought_tokens >= 0),
  total_tokens integer check (total_tokens >= 0),
  created_at timestamptz not null default now()
);
create index provider_usage_request_idx on public.provider_usage (request_id);
create index provider_usage_created_at_idx on public.provider_usage (created_at desc);

create table public.request_events (
  request_id uuid not null references public.extraction_requests(id) on delete cascade,
  ordinal integer not null check (ordinal >= 0),
  event text not null check (length(event) between 1 and 120),
  fields jsonb not null check (jsonb_typeof(fields) = 'object'),
  primary key (request_id, ordinal)
);

alter table public.extraction_requests enable row level security;
alter table public.places enable row level security;
alter table public.request_places enable row level security;
alter table public.provider_usage enable row level security;
alter table public.request_events enable row level security;
revoke all on public.extraction_requests, public.places, public.request_places,
  public.provider_usage, public.request_events from public, anon, authenticated;
grant select, insert, update, delete on public.extraction_requests, public.places,
  public.request_places, public.provider_usage, public.request_events to service_role;

-- One transaction prevents a finished request with missing result/usage rows.
-- Invoker privileges are intentional; only the backend service role can call it.
create function public.complete_extraction_request(
  p_request_id uuid, p_status text, p_duration_ms integer,
  p_replies_sent integer, p_replies_failed integer,
  p_places jsonb, p_usage jsonb, p_events jsonb
) returns void language plpgsql security invoker set search_path = '' as $$
begin
  if p_status not in ('completed', 'partial', 'no_places', 'failed', 'unsupported') then
    raise exception 'Invalid terminal status';
  end if;
  update public.extraction_requests
    set status = p_status, completed_at = now(), duration_ms = p_duration_ms,
        replies_sent = p_replies_sent, replies_failed = p_replies_failed
    where id = p_request_id and status = 'processing';
  if not found then return; end if;

  insert into public.places (google_place_id)
    select distinct google_place_id
    from jsonb_to_recordset(p_places) as p(google_place_id text)
    where google_place_id is not null
    on conflict (google_place_id) do nothing;
  insert into public.request_places
    (request_id, ordinal, google_place_id, mention_name, city, country, match_kind, confidence, photo_available)
    select p_request_id, ordinal, google_place_id, mention_name, city, country, match_kind, confidence, photo_available
    from jsonb_to_recordset(p_places) as p(
      ordinal integer, google_place_id text, mention_name text, city text, country text,
      match_kind text, confidence text, photo_available boolean
    );
  insert into public.provider_usage
    (id, request_id, provider, operation, model, succeeded, http_status, duration_ms,
     input_tokens, output_tokens, cached_tokens, thought_tokens, total_tokens)
    select id, p_request_id, provider, operation, model, succeeded, http_status, duration_ms,
      input_tokens, output_tokens, cached_tokens, thought_tokens, total_tokens
    from jsonb_to_recordset(p_usage) as u(
      id uuid, provider text, operation text, model text, succeeded boolean, http_status integer,
      duration_ms integer, input_tokens integer, output_tokens integer, cached_tokens integer,
      thought_tokens integer, total_tokens integer
    );
  insert into public.request_events (request_id, ordinal, event, fields)
    select p_request_id, ordinal, event, fields
    from jsonb_to_recordset(p_events) as e(ordinal integer, event text, fields jsonb);
end;
$$;
revoke all on function public.complete_extraction_request(uuid,text,integer,integer,integer,jsonb,jsonb,jsonb)
  from public, anon, authenticated;
grant execute on function public.complete_extraction_request(uuid,text,integer,integer,integer,jsonb,jsonb,jsonb)
  to service_role;

create view public.request_metrics_daily with (security_invoker = true) as
select (created_at at time zone 'UTC')::date as day,
  count(*) as requests, count(distinct sender_ref) as unique_users,
  count(*) filter (where status = 'completed') as completed,
  count(*) filter (where status = 'partial') as partial,
  count(*) filter (where status = 'failed') as failed,
  count(*) filter (where status = 'no_places') as no_places,
  count(*) filter (where status = 'unsupported') as unsupported,
  count(*) filter (where status = 'processing') as processing,
  percentile_cont(0.5) within group (order by duration_ms) as p50_duration_ms,
  percentile_cont(0.95) within group (order by duration_ms) as p95_duration_ms
from public.extraction_requests group by 1;

create view public.provider_metrics_daily with (security_invoker = true) as
select (created_at at time zone 'UTC')::date as day, provider, operation, model,
  count(*) as attempted_calls,
  count(*) filter (where not succeeded) as failed_calls,
  count(total_tokens) as calls_with_token_usage,
  sum(input_tokens) as input_tokens, sum(output_tokens) as output_tokens,
  sum(cached_tokens) as cached_tokens, sum(thought_tokens) as thought_tokens,
  sum(total_tokens) as total_tokens
from public.provider_usage group by 1, 2, 3, 4;

-- Interest from high-confidence matches, not ratings or proof of a visit.
create view public.place_popularity with (security_invoker = true) as
select p.google_place_id,
  count(distinct r.id) as extraction_requests,
  count(distinct r.sender_ref) as unique_users,
  count(distinct r.reel_ref) as unique_reels,
  max(r.created_at) as last_extracted_at
from public.request_places p join public.extraction_requests r on r.id = p.request_id
where p.confidence = 'high' and r.status in ('completed', 'partial')
group by p.google_place_id;

revoke all on public.request_metrics_daily, public.provider_metrics_daily, public.place_popularity
  from public, anon, authenticated;
grant select on public.request_metrics_daily, public.provider_metrics_daily, public.place_popularity
  to service_role;
