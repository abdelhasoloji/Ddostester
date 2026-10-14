# Frontend

React/Vite assets are served statically by the API in production. Development uses the workspace dev server and API proxy. Check API and UI build identity independently on release promotion; repository main does not identify a deployed bundle by itself.

Campaigns includes the versioned catalogue and DRS assessment workspace: modes, draft revisions, freeze/capacity, explicit software fixtures, evidence and reports. Fleet manages site-paged inventory/enrollment, selected agents, missions and detailed evidence. Run Theater keeps campaign graphs and a compact dynamic active/assigned bot count; unknown telemetry is not zero activity.

Capabilities and effective limits come from the server. Viewer and expired sessions cannot gain writes through UI labels. Simulation is labelled no-traffic; archived campaigns remain readable. Disabled physical catalogue rows do not fall back locally. See [usage](../usage.md), [Fleet](../fleet-management.md) and [current setup](../current-setup.md).
