# Energy Manager

Private cloud dashboard for inverter energy readings.

## Forecasts

Run [forecast-read.sql](forecast-read.sql) once in the Supabase SQL Editor after setting up NAS forecast publishing. The GitHub Forecasts tab uses the same publishable-key connection as Overview. Use **Refresh forecast** to read the latest snapshot. The NAS downloads and publishes forecasts.

## Control

With the NAS publishing `control_graph`, open **Control** and sign in with the existing Supabase forecast uploader account. The dashboard displays the latest NAS charge plan and refreshes when Supabase publishes a new one. The sign-in lasts until you sign out or reload the page.
