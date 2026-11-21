-- Run once in the same Supabase project after supabase_control_graph.sql.
-- The NAS publishes finished display values; the website only reads them.
begin;
create table if not exists public.dashboard_display (
    kind text primary key check (kind in ('solar', 'demand', 'control')),
    updated_at timestamptz not null,
    data jsonb not null check (jsonb_typeof(data) = 'object' and pg_column_size(data) <= 2097152)
);
alter table public.dashboard_display enable row level security;
revoke all on public.dashboard_display from public, anon, authenticated;
grant select on public.dashboard_display to anon, authenticated;
drop policy if exists dashboard_display_read on public.dashboard_display;
create policy dashboard_display_read on public.dashboard_display for select to anon, authenticated using (true);
create or replace function public.publish_dashboard_display(snapshots jsonb)
returns void language plpgsql security definer set search_path = '' as $body$
begin
    if not public.control_graph_uploader_allowed() then
        raise exception using errcode = '42501', message = 'NAS uploader is not authorised.';
    end if;
    if jsonb_typeof(snapshots) is distinct from 'array' or jsonb_array_length(snapshots) > 3 then
        raise exception using errcode = '22023', message = 'Invalid display snapshots.';
    end if;
    insert into public.dashboard_display as saved (kind, updated_at, data)
        select kind, updated_at, data from jsonb_to_recordset(snapshots)
            as r(kind text, updated_at timestamptz, data jsonb)
        on conflict (kind) do update set updated_at = excluded.updated_at, data = excluded.data
            where excluded.updated_at >= saved.updated_at;
end;
$body$;
revoke all on function public.publish_dashboard_display(jsonb) from public, anon;
grant execute on function public.publish_dashboard_display(jsonb) to authenticated;
do $realtime$
begin
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime'
        and schemaname = 'public' and tablename = 'dashboard_display') then
        alter publication supabase_realtime add table public.dashboard_display;
    end if;
end;
$realtime$;
commit;
