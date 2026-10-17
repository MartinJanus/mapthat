-- Only the backend has data access; make that policy explicit.
create policy backend_only on public.extraction_requests for all to service_role using (true) with check (true);
create policy backend_only on public.places for all to service_role using (true) with check (true);
create policy backend_only on public.request_places for all to service_role using (true) with check (true);
create policy backend_only on public.provider_usage for all to service_role using (true) with check (true);
create policy backend_only on public.request_events for all to service_role using (true) with check (true);

-- Supabase's existing event-trigger helper has no client-facing purpose.
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end;
$$;
