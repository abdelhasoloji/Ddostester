# Component reference

Current control-plane source map. [Architecture](../architecture.md), [API](../api.md) and [current setup](../current-setup.md) separate source behavior from deployment observations.

| Component                | Reference                           | Source                                                        |
| ------------------------ | ----------------------------------- | ------------------------------------------------------------- |
| API/server               | [API process](backend-api.md)       | `backend/src/app.ts`, `server.ts`, `routes/`                  |
| Generators/Fleet         | [Generation](load-generator.md)     | `agents/`, `engine/`, `modules/fleet/`                        |
| Synthetic bench contract | [Bench dispatch](bench-dispatch.md) | `modules/bench/`, companion lab                               |
| Measurement providers    | [Connectors](connectors.md)         | `modules/protection/`, `modules/telemetry/`, `modules/probe/` |
| Persistence              | [Store](store.md)                   | `backend/src/store/`                                          |
| UI                       | [Frontend](frontend.md)             | `frontend/src/`                                               |

DRS reference/scoring/evidence are in `modules/drs/`; see [DRS engine](../drs-engine.md). Authorized public/private HTTP is supported; synthetic network emission remains a separate laboratory path.
