# FastAPI Lifespan Implementation Plan

Goal:
Replace deprecated FastAPI startup event registration with lifespan while preserving startup behavior exactly.

Architecture:
Define one asynccontextmanager lifespan function in app/main.py.
Run the existing Whisper preload and RAG warmup sequentially before yield.
Pass that lifespan function to FastAPI.

Global constraints:
- Preserve startup order: get_whisper_model() then warm_rag_runtime().
- Do not parallelize startup work.
- Do not add shutdown behavior.
- Do not change Whisper initialization logic.
- Do not change RAG initialization logic.
- Do not change routes, CORS, health checks, or API responses.

Task 1: Replace startup event with lifespan

Files:
- Modify backend/ai-api/app/main.py
- Modify backend/ai-api/tests/test_rag_startup_warmup.py

Step 1:
Replace the existing preload_models startup test with a lifespan test.

Expected startup order:
whisper -> rag -> running

Also verify app.router.on_startup is empty.

Step 2:
Run the lifespan test and verify RED.
It must fail because app.main does not expose lifespan yet.

Step 3:
Add asynccontextmanager lifespan to app/main.py.

The lifespan must:
1. call get_whisper_model()
2. call warm_rag_runtime()
3. yield

Pass lifespan=lifespan to FastAPI.

Remove the deprecated @app.on_event("startup") handler.

Step 4:
Run tests/test_rag_startup_warmup.py and tests/test_rag_health.py.

Step 5:
Run the full backend pytest suite.

Step 6:
Commit only app/main.py and test_rag_startup_warmup.py for the implementation.
