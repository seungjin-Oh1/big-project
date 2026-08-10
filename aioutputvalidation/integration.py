"""Adapter between existing RAG response dictionaries and validation.py.

No backend imports are used here: the API layer can inject its embedding function
without exposing secrets or making validation depend on a particular vector store.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import Any

from validator import ValidationResult, validate

EmbeddingFunction = Callable[[list[str]], list[Sequence[float]]]

UNCERTAINTY_CUES = ("확인필요", "확인 필요", "추가 확인", "가능성", "판단하기 어렵", "단정할 수 없")


def extract_claims(ai_output: dict[str, Any]) -> list[str]:
    """Extract auditable factual claim candidates, not new legal conclusions."""
    claims = [str(ai_output.get("summary", "")).strip()]
    extracted = ai_output.get("extracted_json", {})
    if isinstance(extracted, dict):
        claims.append(str(extracted.get("사건개요", "")).strip())
    timeline = ai_output.get("timeline_json", [])
    if isinstance(timeline, list):
        claims.extend(str(item.get("내용", "")).strip() for item in timeline if isinstance(item, dict))
    return list(dict.fromkeys(claim for claim in claims if claim))


def _with_euro(word: str) -> str:
    """'으로/로'를 앞말 받침에 맞춰 붙인다("충족으로", "확인필요로").

    문장이 그대로 임베딩되므로 조사가 틀리면 근거와의 유사도에도 영향을 준다.
    받침이 없거나 'ㄹ'이면 '로', 그 밖에는 '으로'."""
    if not word:
        return word
    code = ord(word[-1]) - 0xAC00
    if not 0 <= code <= 11171:      # 한글 음절이 아니면 안전한 쪽으로
        return f"{word}로"
    jongseong = code % 28
    return f"{word}로" if jongseong in (0, 8) else f"{word}으로"


def extract_legal_claims(ai_output: dict[str, Any]) -> list[str]:
    """법령·판례로 뒷받침되어야 하는 판단만 뽑는다. 사실관계는 뽑지 않는다.

    extract_claims는 summary·사건개요·타임라인을 주장으로 삼는데, 그건 전부
    상담자가 말한 사실이다. "남편이 2026년 6월 18일 사망했다"가 민법 조문에
    있을 리 없으므로 근거 점수가 늘 낮게 나오고, 멀쩡한 분석에도 환각 위험이
    높게 찍혔다(실측: 근거부족+인용없음이면 확률 1.0000).

    법령에 근거해야 마땅한 것은 '판단'이다 — 사건의 법적 성격, 구조대상 여부,
    요건 충족 여부. 이것들만 뽑아야 "이 판단이 이 조문으로 뒷받침되는가"라는
    질문이 성립한다.

    extract_claims는 그대로 둔다. 라벨링·학습·평가 파이프라인 여러 곳이 그것을
    쓰고 있어서, 바꾸면 이미 만든 학습 데이터와 MLP의 보정값이 함께 무효가 된다.
    """
    claims: list[str] = []

    case_type = str(ai_output.get("case_type", "")).strip()
    case_subtype = str(ai_output.get("case_subtype", "")).strip()
    if case_type and case_subtype:
        claims.append(f"이 사건은 {case_type} 중 {case_subtype}에 해당한다.")
    elif case_type:
        claims.append(f"이 사건은 {case_type}에 해당한다.")

    eligibility = str(ai_output.get("eligibility", "")).strip()
    if eligibility:
        claims.append(f"법률구조 대상 여부는 {_with_euro(eligibility)} 판단된다.")

    checklist = ai_output.get("checklist_json", [])
    if isinstance(checklist, list):
        for item in checklist:
            if not isinstance(item, dict):
                continue
            name = str(item.get("항목", "")).strip()
            result = str(item.get("결과", "")).strip()
            if name and result:
                claims.append(f"{name} 요건은 {_with_euro(result)} 판단된다.")

    return list(dict.fromkeys(claim for claim in claims if claim))


def extract_evidence(rag_results: list[dict[str, Any]]) -> tuple[list[str], int]:
    """Use only RAG text returned by the service and count usable citations."""
    texts: list[str] = []
    cited_count = 0
    for result in rag_results:
        content = str(result.get("content", "")).strip()
        citation = str(result.get("citation", "")).strip()
        if content:
            texts.append(content)
            cited_count += int(bool(citation))
    return texts, cited_count


def has_uncertainty_disclosure(claims: list[str]) -> bool:
    """Detect explicit Korean uncertainty language already present in the AI output."""
    return any(cue in claim for claim in claims for cue in UNCERTAINTY_CUES)


def validate_rag_output(
    ai_output: dict[str, Any],
    rag_results: list[dict[str, Any]],
    embed: EmbeddingFunction,
    uncertainty_disclosed: bool | None = None,
) -> ValidationResult:
    """Create embeddings locally through the injected function and validate output."""
    claims = extract_claims(ai_output)
    evidence_texts, usable_citations = extract_evidence(rag_results)
    claim_embeddings = embed(claims) if claims else []
    evidence_embeddings = embed(evidence_texts) if evidence_texts else []
    disclosed = has_uncertainty_disclosure(claims) if uncertainty_disclosed is None else uncertainty_disclosed
    return validate(
        ai_output,
        claim_embeddings,
        evidence_embeddings,
        cited_claim_count=min(len(claims), usable_citations),
        uncertainty_disclosed=disclosed,
    )


def flatten_legal_sources(legal_sources: dict[str, list[dict[str, Any]]]) -> list[dict[str, Any]]:
    """Flatten the existing related_statutes/related_precedents API shape."""
    return [
        item
        for key in ("related_statutes", "related_precedents")
        for item in legal_sources.get(key, [])
        if isinstance(item, dict)
    ]


def validate_rag_output_with_service(
    ai_output: dict[str, Any],
    legal_sources: dict[str, list[dict[str, Any]]],
    embedding_service: Any,
    uncertainty_disclosed: bool | None = None,
    claim_extractor: Callable[[dict[str, Any]], list[str]] = extract_claims,
) -> ValidationResult:
    """Adapter for the existing EmbeddingService (query/passages use E5 prefixes).

    claim_extractor를 갈아끼울 수 있게 열어 둔다. 기본값은 종전대로 extract_claims라
    기존 호출부의 동작은 그대로다. 변호사가 담은 법령·판례로 검증할 때는
    extract_legal_claims를 넘겨 사실관계 대신 판단을 대조한다.
    """
    claims = claim_extractor(ai_output)
    evidence_texts, usable_citations = extract_evidence(flatten_legal_sources(legal_sources))
    claim_embeddings = [embedding_service.embed_query(claim) for claim in claims]
    evidence_embeddings = embedding_service.embed_documents(evidence_texts)
    disclosed = has_uncertainty_disclosure(claims) if uncertainty_disclosed is None else uncertainty_disclosed
    return validate(
        ai_output,
        claim_embeddings,
        evidence_embeddings,
        cited_claim_count=min(len(claims), usable_citations),
        uncertainty_disclosed=disclosed,
    )
