# Energy Manager

Private cloud dashboard for inverter energy readings.

## Forecasts

Run [forecast-read.sql](forecast-read.sql) once in the Supabase SQL Editor after setting up NAS forecast publishing. The GitHub Forecasts tab uses the same publishable-key connection as Overview. Use **Refresh forecast** to read the latest snapshot. The NAS downloads and publishes forecasts.

## Control

Once the NAS is publishing `control_graph`, run [control-read.sql](control-read.sql) in the same Supabase project. **Control** uses the dashboard's existing publishable-key connection and refreshes when the NAS publishes a new plan. Anyone with the project URL and publishable key can read the Control snapshot. Uploads still require the configured NAS uploader.
