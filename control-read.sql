-- Run after supabase_control_graph.sql to enable the GitHub dashboard's Control tab.
-- The project URL and publishable key allow anyone to read the Control snapshot.
-- This grants SELECT only. NAS uploads still require the configured uploader.
begin;
alter table public.control_graph enable row level security;
grant select on public.control_graph to anon;

do $control_read$
begin
    if not exists (
        select 1 from pg_catalog.pg_policies
        where schemaname = 'public' and tablename = 'control_graph'
            and policyname = 'dashboard_read_control_graph_anon'
    ) then
        create policy dashboard_read_control_graph_anon
            on public.control_graph for select to anon using (true);
    end if;
end;
$control_read$;

commit;
