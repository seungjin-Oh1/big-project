"""Warm RAG dependencies before serving requests."""

from rag.consultation_retriever import (
    get_default_consultation_retriever,
)
from rag.embedding_service import (
    get_default_embedding_service,
)
from rag.precedent_retriever import (
    get_default_precedent_retriever,
)
from rag.statute_retriever import (
    get_default_statute_retriever,
)


WARMUP_QUERY = "\ubc95\ub960 \uc0c1\ub2f4"


def warm_rag_runtime() -> dict[str, int]:
    """Load the embedding model and touch each Chroma collection."""
    embedding_service = (
        get_default_embedding_service()
    )
    embedding_service.embed_query(
        WARMUP_QUERY
    )

    retrievers = {
        "statutes": (
            get_default_statute_retriever()
        ),
        "precedents": (
            get_default_precedent_retriever()
        ),
        "consultations": (
            get_default_consultation_retriever()
        ),
    }

    return {
        name: retriever.vector_store.count()
        for name, retriever in retrievers.items()
    }
