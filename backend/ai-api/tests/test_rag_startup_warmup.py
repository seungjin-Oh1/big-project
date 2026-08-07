from types import SimpleNamespace

import app.rag_warmup as rag_warmup


def test_warm_rag_runtime_loads_embedding_and_collections(
    monkeypatch,
):
    calls = []

    class FakeEmbeddingService:
        def embed_query(self, text):
            calls.append(
                ("embed_query", text)
            )
            return [0.1, 0.2]

    def fake_retriever(name):
        return SimpleNamespace(
            vector_store=SimpleNamespace(
                count=lambda: (
                    calls.append(
                        ("count", name)
                    )
                    or 10
                )
            )
        )

    monkeypatch.setattr(
        rag_warmup,
        "get_default_embedding_service",
        lambda: FakeEmbeddingService(),
    )

    monkeypatch.setattr(
        rag_warmup,
        "get_default_statute_retriever",
        lambda: fake_retriever(
            "statutes"
        ),
    )

    monkeypatch.setattr(
        rag_warmup,
        "get_default_precedent_retriever",
        lambda: fake_retriever(
            "precedents"
        ),
    )

    monkeypatch.setattr(
        rag_warmup,
        "get_default_consultation_retriever",
        lambda: fake_retriever(
            "consultations"
        ),
    )

    result = (
        rag_warmup.warm_rag_runtime()
    )

    assert calls[0][0] == "embed_query"

    assert (
        ("count", "statutes")
        in calls
    )
    assert (
        ("count", "precedents")
        in calls
    )
    assert (
        ("count", "consultations")
        in calls
    )

    assert result == {
        "statutes": 10,
        "precedents": 10,
        "consultations": 10,
    }


def test_preload_models_warms_whisper_and_rag(
    monkeypatch,
):
    import app.main as main

    calls = []

    monkeypatch.setattr(
        main,
        "get_whisper_model",
        lambda: calls.append("whisper"),
    )

    monkeypatch.setattr(
        main,
        "warm_rag_runtime",
        lambda: calls.append("rag"),
        raising=False,
    )

    main.preload_models()

    assert calls == [
        "whisper",
        "rag",
    ]
