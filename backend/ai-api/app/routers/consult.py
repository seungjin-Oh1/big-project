import asyncio
import logging

from time import perf_counter

from fastapi import APIRouter

from app.ai.analysis import service as analysis_service
from app.ai.consult.graph import run_consult_analysis
from app.ai.output_validation.service import (
    validate_against_adopted_sources,
    validate_consultation_output,
)
from app.ai.consult.rag_service import (
    collect_related_legal_sources,
)
from app.ai.consult.schemas import (
    ConsultAnalyzeResponse,
    RawInput,
)
from app.ai.stt import extract as stt_extract


logger = logging.getLogger(__name__)


router = APIRouter(
    prefix="/consult",
    tags=["consult"],
)


@router.post(
    "/analyze",
    response_model=ConsultAnalyzeResponse,
)
async def analyze_consult(
    payload: RawInput,
) -> dict:
    """Run the consultation analysis pipeline once."""
    request_started = perf_counter()
    content = payload.content.model_dump()

    # 1) Extract text from attached files.
    file_links = (
        stt_extract.normalize_file_links(
            content.get(
                "summited_file_link"
            )
        )
    )
    extract_started = perf_counter()

    try:
        extracted = await asyncio.to_thread(
            stt_extract.extract_all,
            file_links,
        )
    finally:
        logger.info(
            (
                "consult_analyze_stage "
                "stage=extract "
                "elapsed_ms=%.2f"
            ),
            (
                perf_counter()
                - extract_started
            ) * 1000,
        )

    # 2) Existing analysis and consult graphs may use raw
    # consultation text according to their existing contract.
    consult_text = (
        analysis_service.build_consult_text(
            content.get("summary", ""),
            content.get("details", ""),
            extracted.text,
        )
    )
    analysis_started = perf_counter()

    try:
        analysis = await asyncio.to_thread(
            analysis_service.analyze,
            consult_text,
        )
    finally:
        logger.info(
            (
                "consult_analyze_stage "
                "stage=analysis "
                "elapsed_ms=%.2f"
            ),
            (
                perf_counter()
                - analysis_started
            ) * 1000,
        )

    # 판정 계층도 같은 원문을 본다. 주민등록번호·전화번호는 여기서도 지운다 -
    # 구조대상 판단과 누락자료 목록에 번호가 실려 나갈 이유가 없고, 실측에서
    # 분석 요약에 지어낸 주민번호가 찍힌 적이 있다(analysis/service.py 주석 참고).
    scrub = analysis_service.scrub_sensitive_numbers
    safe_content = {
        **content,
        "summary": scrub(content.get("summary", "")),
        "details": scrub(content.get("details", "")),
    }

    # 3) RAG는 content.anonymized_text만 읽는다. 없으면 검색하지 않는다.
    #
    # 원문으로 폴백하지 않는 것은 설계 결정이다
    # (docs/superpowers/specs/2026-08-05-family-law-consultation-rag-design.md 11절:
    #  "마스킹 결과가 없을 때 원문으로 폴백하지 않음 / 익명화 텍스트가 없으면 빈 배열").
    #
    # core-api가 분석을 요청할 때 그 자리에서 가려 넘겨준다
    # (AiAnalysisService.buildCombinedAnonymizedText). 가림본을 따로 저장해 두지 않으므로
    # 상담 종류(전화·대면·수기)와 무관하게 늘 채워져 온다.
    graph_state = {
        "content": safe_content,
        "extracted": {
            "texts": [
                scrub(text)
                for text
                in (extracted.texts or [])
            ],
            "details": extracted.details,
            "text": scrub(
                extracted.text or ""
            ),
        },
    }

    # The graph and RAG search are independent.
    # Run both concurrently and record their
    # timings separately.
    async def run_graph_with_timing():
        graph_started = perf_counter()

        try:
            return await run_consult_analysis(
                graph_state
            )
        finally:
            logger.info(
                (
                    "consult_analyze_stage "
                    "stage=consult_graph "
                    "elapsed_ms=%.2f"
                ),
                (
                    perf_counter()
                    - graph_started
                ) * 1000,
            )

    async def run_rag_with_timing():
        rag_started = perf_counter()

        try:
            return await asyncio.to_thread(
                collect_related_legal_sources,
                content=content,
                top_n=5,
            )
        finally:
            logger.info(
                (
                    "consult_analyze_stage "
                    "stage=rag "
                    "elapsed_ms=%.2f"
                ),
                (
                    perf_counter()
                    - rag_started
                ) * 1000,
            )

    result, legal_sources = (
        await asyncio.gather(
            run_graph_with_timing(),
            run_rag_with_timing(),
        )
    )

    # Output validation may load and execute
    # local model code, so keep it off the
    # event-loop thread as well.
    validation_started = perf_counter()

    try:
        output_validation = (
            await asyncio.to_thread(
                validate_consultation_output,
                analysis_output=(
                    analysis_service
                    .without_draft_contact(
                        analysis.output
                    )
                ),
                legal_sources=legal_sources,
            )
        )
    finally:
        logger.info(
            (
                "consult_analyze_stage "
                "stage=output_validation "
                "elapsed_ms=%.2f"
            ),
            (
                perf_counter()
                - validation_started
            ) * 1000,
        )

    logger.info(
        (
            "consult_analyze_completed "
            "total_ms=%.2f "
            "statutes=%d "
            "precedents=%d "
            "consultations=%d"
        ),
        (
            perf_counter()
            - request_started
        ) * 1000,
        len(
            legal_sources.get(
                "related_statutes"
            )
            or []
        ),
        len(
            legal_sources.get(
                "related_precedents"
            )
            or []
        ),
        len(
            legal_sources.get(
                "related_consultations"
            )
            or []
        ),
    )

    return {
        **result,
        **analysis.to_dict(),
        **legal_sources,
        "output_validation": output_validation,
    }


@router.post("/validate")
def validate_with_adopted_sources(payload: dict) -> dict:
    """변호사가 검토 근거로 담은 법령·판례로 분석 결과를 다시 검증한다.

    /analyze 안의 검증은 RAG가 상담 내용으로 자동 검색한 상위 5건을 근거로 삼고,
    주장으로는 요약·사건개요·타임라인을 쓴다. 그런데 그건 전부 상담자가 말한
    사실이라 법 조문과 닮을 이유가 없다 — 멀쩡한 분석에도 환각 위험이 높게 찍혔다.

    여기서는 근거와 주장을 둘 다 바꾼다. 근거는 변호사가 '이 사건의 근거로
    삼겠다'고 고른 것이고, 주장은 사건의 법적 성격·구조대상 여부·요건 충족처럼
    법령에 근거해야 마땅한 판단만 뽑는다. 그래야 "이 판단이 이 조문으로
    뒷받침되는가"라는 물음이 성립한다.

    payload: {"analysis_output": {...}, "adopted": [{type, title, content, ...}]}
      adopted는 검색 화면이 저장하는 모양 그대로 넘기면 된다
      (recommendation_json.adopted / SearchWorkbench.saveSelected).
    """
    analysis_output = payload.get("analysis_output")
    if isinstance(analysis_output, dict):
        # 자동 검증과 같은 이유로 서식용 연락처 키는 빼고 넘긴다.
        analysis_output = analysis_service.without_draft_contact(analysis_output)
    return {
        "output_validation": validate_against_adopted_sources(
            analysis_output=analysis_output,
            adopted=payload.get("adopted"),
        )
    }
