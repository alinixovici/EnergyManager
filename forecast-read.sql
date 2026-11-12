-- Run once after the NAS publishing setup.
-- Match the GitHub dashboard's existing publishable-key read access.
-- Anyone with this project's API URL and publishable key can read the snapshot.
begin;
alter table public.solar_generation_estimate enable row level security;
grant select on public.solar_generation_estimate to anon;
drop policy if exists dashboard_read_solar_forecast on public.solar_generation_estimate;
create policy dashboard_read_solar_forecast
    on public.solar_generation_estimate for select to anon using (true);
commit;
