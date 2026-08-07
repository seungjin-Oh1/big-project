"""Non-blocking bridge to the sibling aioutputvalidation project; never reads .env."""
from __future__ import annotations
import logging, sys
from functools import lru_cache
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

def _root() -> Path:
    for parent in Path(__file__).resolve().parents:
        candidate=parent/'aioutputvalidation'
        if (candidate/'integration.py').is_file(): return candidate
    raise RuntimeError('aioutputvalidation unavailable')

@lru_cache(maxsize=1)
def _validation_functions():
    root=_root(); sys.path.insert(0,str(root)) if str(root) not in sys.path else None
    from integration import validate_rag_output_with_service
    from audit import build_audit_record
    return validate_rag_output_with_service, build_audit_record

@lru_cache(maxsize=1)
def _legal_claim_extractor():
    root=_root(); sys.path.insert(0,str(root)) if str(root) not in sys.path else None
    from integration import extract_legal_claims
    return extract_legal_claims

class _E5EmbeddingService:
    """query/passage-prefixed E5 embeddings, matching aioutputvalidation's own e5_embedders."""
    def __init__(self, model: Any) -> None:
        self._model = model
    def embed_query(self, text: str) -> list[float]:
        return self._model.encode([f'query: {text}'], normalize_embeddings=True, show_progress_bar=False)[0].tolist()
    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        if not texts: return []
        return self._model.encode([f'passage: {x}' for x in texts], normalize_embeddings=True, show_progress_bar=False).tolist()

@lru_cache(maxsize=1)
def _embedding_service() -> "_E5EmbeddingService":
    from sentence_transformers import SentenceTransformer
    return _E5EmbeddingService(SentenceTransformer('intfloat/multilingual-e5-small'))

# ── 저장 형식 → 검증 스키마 통역 ────────────────────────────────────────────
# aioutputvalidation/schema/ai_analysis.schema.json과 우리가 DB에 저장하는 모양은
# 네 군데가 다르다. 내용이 아니라 키 이름·자료형만 다른데, validator는
#   if errors or probability >= threshold: decision = "high_risk"
# 라서 스키마 오류가 하나만 있어도 근거 점수와 무관하게 '환각 위험 높음'이 뜬다.
# 상담 45번이 근거 점수 0.9074인데도 빨갛게 뜬 이유가 이것뿐이었다(스키마 오류 12건).
#
# 저장 형식을 바꾸면 화면·서식 초안이 연쇄로 깨지고, 스키마를 바꾸면 schema_error가
# MLP 학습 특징이라 모델 보정이 흔들린다. 그래서 양쪽을 그대로 두고 검증에 넘기기
# 직전에만 통역한다. 값은 옮기기만 하고 없는 판단을 만들어내지 않는다.
_ELIGIBILITY_ENUM = ('대상후보', '비대상후보', '확인필요')
_ELIGIBILITY_ALIAS = {
    '구조 가능': '대상후보', '대상': '대상후보', 'eligible': '대상후보',
    '부적합': '비대상후보', '비대상': '비대상후보', 'ineligible': '비대상후보',
    '검토 필요': '확인필요', '판단보류': '확인필요', '보류': '확인필요', 'pending': '확인필요',
}
_SCHEMA_TOP_KEYS = ('analysis_id','consultation_id','summary','case_type','case_subtype',
                    'urgency_level','eligibility','extracted_json','missing_info_json',
                    'checklist_json','timeline_json','recommendation_json',
                    'cluster_result_json','estimated_time','created_at')
# 스키마가 요구하는 네 항목. 빠져 있으면 '자료 없음'에 해당하는 빈 값으로 채운다.
_EXTRACTED_DEFAULT: dict[str,Any] = {'당사자': [], '금액': None, '날짜': [], '사건개요': ''}
_EXTRACTED_ITEM_KEYS = {'당사자': ('역할','이름'), '날짜': ('항목','값')}
# 법률구조 심사 4요건. 저장 형식은 요건별 상세 객체인데, '충족/미충족' 판정을 실제로
# 갖고 있는 건 구조대상자 여부(eligible)뿐이다. 나머지 셋은 판정 필드 자체가 없으므로
# '확인필요'로 넘긴다 — 상세 소견을 임의로 충족/미충족으로 바꾸지 않는다.
_CHECKLIST_ITEMS = (('eligibility','구조대상자 여부'), ('winnability','승소가능성'),
                    ('executability','집행가능성'), ('appropriateness','구조타당성'))
_CHECKLIST_RESULT = {'대상': '충족', '비대상': '미충족'}


def _rows(value: Any, keys: tuple[str,...]) -> list[dict[str,Any]]:
    """additionalProperties: false라 스키마가 아는 키만 남긴다."""
    return [{k: item[k] for k in keys if k in item}
            for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _normalize_extracted(value: Any) -> dict[str,Any]:
    if not isinstance(value, dict):
        return dict(_EXTRACTED_DEFAULT)
    kept = {k: value[k] for k in _EXTRACTED_DEFAULT if k in value}
    for key, item_keys in _EXTRACTED_ITEM_KEYS.items():
        if key in kept:
            kept[key] = _rows(kept[key], item_keys)
    amount = kept.get('금액')
    if amount is not None and not isinstance(amount, int):
        digits = ''.join(ch for ch in str(amount) if ch.isdigit())
        kept['금액'] = int(digits) if digits else None   # 못 읽으면 비운다
    if '사건개요' in kept:
        kept['사건개요'] = str(kept['사건개요'] or '')
    return {**_EXTRACTED_DEFAULT, **kept}


def _normalize_checklist(value: Any) -> list[dict[str,str]]:
    if isinstance(value, list):
        return _rows(value, ('항목','결과'))          # 이미 스키마 모양
    if not isinstance(value, dict):
        return []
    items = []
    for key, label in _CHECKLIST_ITEMS:
        section = value.get(key)
        if not isinstance(section, dict):
            continue
        verdict = str(section.get('eligible') or '').strip()
        items.append({'항목': label, '결과': _CHECKLIST_RESULT.get(verdict, '확인필요')})
    return items


def _normalize_timeline(value: Any) -> list[dict[str,str]]:
    if not isinstance(value, list):
        return []
    rows = []
    for item in value:
        if not isinstance(item, dict):
            continue
        rows.append({'날짜': str(item.get('날짜') or item.get('date') or ''),
                     '내용': str(item.get('내용') or item.get('text') or '')})
    return rows


def normalize_for_schema(analysis_output: dict[str,Any]|None) -> dict[str,Any]|None:
    """검증에 넘길 사본을 스키마 모양으로 맞춘다. 원본은 건드리지 않는다."""
    if not isinstance(analysis_output, dict):
        return analysis_output
    out = {k: v for k, v in analysis_output.items() if k in _SCHEMA_TOP_KEYS}
    eligibility = str(out.get('eligibility') or '').strip()
    # 모르는 값은 '확인필요'로 — 없는 근거로 '대상후보'라고 말하지 않는 쪽이 안전하다.
    out['eligibility'] = (eligibility if eligibility in _ELIGIBILITY_ENUM
                          else _ELIGIBILITY_ALIAS.get(eligibility, '확인필요'))
    out['extracted_json'] = _normalize_extracted(out.get('extracted_json'))
    out['checklist_json'] = _normalize_checklist(out.get('checklist_json'))
    out['timeline_json'] = _normalize_timeline(out.get('timeline_json'))
    missing = out.get('missing_info_json')
    out['missing_info_json'] = [str(x) for x in missing] if isinstance(missing, list) else []
    return out


def validate_consultation_output(*, analysis_output: dict[str,Any]|None, legal_sources: dict[str,list[dict[str,Any]]]|None = None) -> dict[str,Any]:
    """Validate against RAG-retrieved statutes/precedents, per MODEL_DEFINITION.md section 6
    (validate_rag_output(_with_service) is the documented integration point; claims are checked
    against actual legal_sources content/citation, not against the consultation transcript)."""
    if not isinstance(analysis_output,dict): return {'status':'unavailable','reason':'analysis_output_missing'}
    # 근거가 한 건도 없으면 검증하지 않는다. 대조할 게 없으면 모든 주장의 유사도가
    # 정확히 0.0으로 나오고 환각 확률이 1.0이 되는데, 그건 '지어냈다'가 아니라
    # '비교할 근거가 없다'다. 그대로 내보내면 화면에 '환각 위험 높음'으로 뜬다.
    #
    # 실제로 그렇게 됐다(상담 45번, 실측). collect_related_legal_sources는 개인정보
    # 경계 때문에 content.anonymized_text만 읽는데, core-api는 마스킹본이 없으면
    # anonymized_text에 null을 보낸다(AiAnalysisService.buildCombinedAnonymizedText).
    # 45번은 마스킹본이 0건이라 근거가 통째로 비었고, 스키마는 멀쩡한데도
    # evidence 0.0 / p 1.0 / high_risk가 나왔다.
    if not any((legal_sources or {}).get(key) for key in ('related_statutes','related_precedents')):
        return {'status':'unavailable','reason':'no_legal_sources'}
    try:
        validate_rag_output_with_service, build_audit_record = _validation_functions()
        result = validate_rag_output_with_service(
            ai_output=normalize_for_schema(analysis_output),
            legal_sources=legal_sources or {},
            embedding_service=_embedding_service(),
        )
        return {'status':'available',**build_audit_record(result)}
    except Exception as error:
        logger.exception("Output validation bridge failed; continuing without validation.")
        return {'status':'unavailable','reason':type(error).__name__}


# 변호사가 검토 근거로 담아 둔 법령·판례의 모양. 검색 화면이 저장하는 항목이라
# (SearchWorkbench.saveSelected) 본문은 content에, 출처는 title/source에 들어 있다.
# extract_evidence는 citation 키를 보므로 여기서 맞춰 준다 — 안 맞추면 인용이
# 하나도 없는 것으로 집계돼 환각 확률만 올라간다.
#
# 키 이름은 related_statutes/related_precedents여야 한다. flatten_legal_sources가
# 그 둘만 읽으므로 다른 이름으로 넣으면 근거가 통째로 비고, 그러면 모든 주장의
# 유사도가 정확히 0.0이 되어 환각 확률이 1.0으로 찍힌다(실측). '유사도가 낮다'가
# 아니라 '비교할 게 없다'인데 결과만 보면 구분이 안 된다.
def _adopted_to_legal_sources(adopted: list[dict[str,Any]]|None) -> dict[str,list[dict[str,Any]]]:
    grouped: dict[str,list[dict[str,Any]]] = {'related_statutes': [], 'related_precedents': []}
    for item in adopted or []:
        if not isinstance(item, dict):
            continue
        content = str(item.get('content') or '').strip()
        if not content:
            continue      # 본문이 없으면 대조할 근거가 없다
        citation = str(item.get('title') or item.get('source') or item.get('id') or '').strip()
        key = 'related_precedents' if str(item.get('type')) == 'precedent' else 'related_statutes'
        grouped[key].append({'content': content, 'citation': citation})
    return grouped


def validate_against_adopted_sources(*, analysis_output: dict[str,Any]|None,
                                     adopted: list[dict[str,Any]]|None) -> dict[str,Any]:
    """변호사가 검토 근거로 담은 법령·판례로 분석 결과를 검증한다.

    /consult/analyze 안의 자동 검증과 두 가지가 다르다.

    1. 근거가 'RAG가 상담 내용으로 뽑은 상위 5건'이 아니라 '변호사가 이 사건의
       근거로 삼겠다고 고른 것'이다. 무엇에 비추어 판단했는지가 분명해진다.
    2. 주장으로 사실관계가 아니라 판단을 뽑는다(extract_legal_claims). 자동 검증은
       "남편이 6월 18일 사망했다"를 민법 조문과 대조해서, 멀쩡한 분석에도 환각
       위험이 높게 찍혔다. 여기서는 "이 사건은 상속 중 상속포기에 해당한다"처럼
       법령에 근거해야 마땅한 문장만 대조한다.
    """
    if not isinstance(analysis_output, dict):
        return {'status':'unavailable','reason':'analysis_output_missing'}
    legal_sources = _adopted_to_legal_sources(adopted)
    if not any(legal_sources.values()):
        return {'status':'unavailable','reason':'no_adopted_sources'}
    try:
        validate_rag_output_with_service, build_audit_record = _validation_functions()
        result = validate_rag_output_with_service(
            ai_output=normalize_for_schema(analysis_output),
            legal_sources=legal_sources,
            embedding_service=_embedding_service(),
            claim_extractor=_legal_claim_extractor(),
        )
        return {'status':'available', 'basis':'adopted', **build_audit_record(result)}
    except Exception as error:
        logger.exception("Adopted-source validation failed; continuing without validation.")
        return {'status':'unavailable','reason':type(error).__name__}
