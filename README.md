# Energy Manager

Private cloud dashboard for inverter energy readings.

The website displays values published by the NAS through Supabase. Forecasts,
SOC limits, energy integration, totals, error ranges and battery target times
are calculated on the NAS. The website only formats values and draws graphs.

Install NAS app 18.23 or later and run [display-read.sql](display-read.sql) once
in Supabase after the existing Control setup. Missing snapshots stay unavailable;
the website does not calculate substitutes. Display publication follows inverter
samples independently of the existing forecast and charging-plan schedules.

## Forecasts

Solar and demand graphs read the NAS snapshots in `dashboard_display` using the same publishable-key connection as Overview. **Refresh forecast** reads the latest published snapshot. Downloading weather, running models and preparing measured values happen on the NAS.

## Control

The Control graph, charging totals and battery target times come from the NAS Control display snapshot. Button states come from `control_button_status`. The website has read access only; publishing requires the existing authorised NAS uploader. The original Control setup is a prerequisite for `display-read.sql`.
