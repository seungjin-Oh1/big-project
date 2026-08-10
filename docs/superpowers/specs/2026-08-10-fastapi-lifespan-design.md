# FastAPI Lifespan Migration Design

## Goal

Replace the deprecated `@app.on_event("startup")` registration
with FastAPI lifespan while preserving startup behavior exactly.

## Current behavior

Startup calls these functions in order:

1. `get_whisper_model()`
2. `warm_rag_runtime()`

## Design

- Add an `asynccontextmanager` lifespan function in `app/main.py`.
- Run `get_whisper_model()` and `warm_rag_runtime()` before `yield`.
- Pass the lifespan function to `FastAPI(lifespan=...)`.
- Remove only the deprecated `@app.on_event("startup")` registration.
- Do not parallelize startup work.
- Do not add shutdown behavior.
- Do not change RAG or Whisper initialization logic.

## Compatibility

The existing startup ordering must remain:

`whisper -> rag`

Health routes, routers, CORS configuration, and API behavior
must remain unchanged.

## Testing

Use TDD:

1. Add or adapt a test that executes the lifespan startup path.
2. Verify Whisper and RAG warmup are both called in the same order.
3. Verify the deprecated `on_event` startup registration is gone.
4. Run startup/RAG tests.
5. Run the full backend pytest suite.
