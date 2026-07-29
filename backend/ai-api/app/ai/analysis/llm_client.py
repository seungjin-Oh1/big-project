"""
LLM 기반 법률상담 구조화 모델 - 신규 Google GenAI SDK (google-genai) 실시간 호출 코드

흐름:
  상담 텍스트 --(few-shot 포함 프롬프트)--> Gemini Structured Outputs (response_schema)
             --(pydantic 파싱/검증)--> AIAnalysisSchema
             --(검증 실패 시 재시도)--> 최종 반환
"""

import json
import os
import time
from pathlib import Path
from typing import List, Type

from google import genai
from google.genai import types
from pydantic import BaseModel, ValidationError

from app.schemas.analysis import AIAnalysisSchema
from app.ai.analysis.prompts import SYSTEM_PROMPT

# parents[2] == app/ (이 파일이 app/ai/analysis/ 아래에 있음)
_DATA_PATH = Path(__file__).resolve().parents[2] / "data" / "few_shot_examples.json"

_client: genai.Client | None = None


def _get_client() -> genai.Client:
    """신규 google-genai Client 인스턴스 싱글톤 관리"""
    global _client
    if _client is None:
        api_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
        if not api_key:
            raise ValueError(".env 파일에 GEMINI_API_KEY가 설정되어 있지 않습니다.")
        _client = genai.Client(api_key=api_key)
    return _client


def _prepare_gemini_schema(pydantic_model: Type[BaseModel]) -> dict:
    """
    Gemini API에서 거부하는 'additional_properties', 'title', '$schema' 등의
    비표준 키를 제거하고 $ref 참조를 풀어 Gemini 호환 JSON 스키마 dict를 생성합니다.
    """
    raw_schema = pydantic_model.model_json_schema()
    root_defs = raw_schema.get("$defs", {})

    def resolve_and_clean(node):
        if isinstance(node, dict):
            # $ref 참조가 있는 경우 $defs에서 찾아 인라인으로 해제
            if "$ref" in node:
                ref_key = node["$ref"].split("/")[-1]
                if ref_key in root_defs:
                    resolved = resolve_and_clean(root_defs[ref_key])
                    merged = {k: v for k, v in node.items() if k != "$ref"}
                    merged.update(resolved)
                    return merged

            cleaned = {}
            for k, v in node.items():
                # Gemini API에서 지원하지 않는 스키마 메타 필드 제거
                if k in (
                    "$defs",
                    "additionalProperties",
                    "additional_properties",
                    "title",
                    "$schema",
                    "default",
                ):
                    continue
                cleaned[k] = resolve_and_clean(v)
            return cleaned
        elif isinstance(node, list):
            return [resolve_and_clean(item) for item in node]
        return node

    return resolve_and_clean(raw_schema)


def _load_few_shot_contents() -> List[dict]:
    """few_shot_examples.json -> google-genai contents 대화 배열로 변환"""
    raw = json.loads(_DATA_PATH.read_text(encoding="utf-8"))
    contents: List[dict] = []
    for ex in raw["examples"]:
        contents.append({"role": "user", "parts": [{"text": ex["input"]}]})
        contents.append(
            {
                "role": "model",
                "parts": [{"text": json.dumps(ex["output"], ensure_ascii=False)}],
            }
        )
    return contents


# 모듈 로드 시 1회만 파싱
_FEW_SHOT_CONTENTS = _load_few_shot_contents()
_GEMINI_CLEANED_SCHEMA = _prepare_gemini_schema(AIAnalysisSchema)


def build_contents(consultation_text: str) -> List[dict]:
    """few-shot 대화 흐름 뒤에 실제 입력 상담글을 붙여 대화 배열 생성"""
    contents: List[dict] = list(_FEW_SHOT_CONTENTS)
    contents.append({"role": "user", "parts": [{"text": consultation_text}]})
    return contents


# 기존 기본값이던 gemini-2.5-flash-lite는 신규 사용자에게 더 이상 제공되지 않아
# 호출하면 404가 난다 ("This model ... is no longer available to new users").
# 모델은 언제든 또 내려갈 수 있으니 환경변수(KLAC_GEMINI_MODEL)로 갈아끼울 수 있게 열어둔다.
#
# 특정 모델이 503("high demand")으로 막히는 일이 있는데, 같은 시각에도 사람마다
# 결과가 다르다. 그럴 땐 코드를 고치지 말고 .env에서 갈아끼울 것:
#   KLAC_GEMINI_MODEL=gemini-3.5-flash-lite
FALLBACK_MODEL = "gemini-3.5-flash"

# 서버가 일시적으로 못 받는 상태. 잠시 뒤 다시 부르면 대체로 성공한다.
_TRANSIENT_STATUS = (429, 500, 502, 503, 504)
_TRANSIENT_BACKOFF_SEC = (2, 5, 10)


def _is_transient(error: Exception) -> bool:
    code = getattr(error, "code", None) or getattr(error, "status_code", None)
    if code in _TRANSIENT_STATUS:
        return True
    # SDK 버전에 따라 코드가 속성으로 안 오고 메시지에만 있는 경우가 있다.
    text = str(error)
    return any(str(s) in text for s in _TRANSIENT_STATUS)


def _generate_with_retry(client, model_name, contents, config):
    """일시적 서버 오류면 잠깐 쉬었다 다시 부른다.

    아래 analyze_consultation의 재시도 루프는 스키마 검증 실패만 다시 시도해서,
    503 한 번에 구조화 분석이 통째로 실패했다. 그러면 요약·세부유형·서식 재료가
    전부 비고 판정 결과만 남는다. 실제로 자주 발생한다("high demand").
    """
    last_error: Exception | None = None
    for wait in (*_TRANSIENT_BACKOFF_SEC, None):
        try:
            return client.models.generate_content(
                model=model_name, contents=contents, config=config
            )
        except Exception as e:  # noqa: BLE001 - 일시적 오류만 걸러 재시도, 나머지는 그대로 올린다
            if wait is None or not _is_transient(e):
                raise
            last_error = e
            print(f"[llm_client] 일시적 오류, {wait}초 뒤 재시도: {e}")
            time.sleep(wait)
    raise last_error  # pragma: no cover - 위 루프에서 반드시 반환하거나 raise 된다


def analyze_consultation(
    consultation_text: str,
    model_name: str | None = None,
    max_retries: int = 2,
) -> AIAnalysisSchema:
    """
    상담 텍스트를 받아 신규 google-genai SDK로 AIAnalysisSchema 구조화 분석을 수행.
    """
    # 환경변수는 import 시점이 아니라 호출 시점에 읽는다.
    # 이 모듈이 load_dotenv()보다 먼저 import될 수 있어서(.env는 ai/config.py가 읽는다),
    # 모듈 상수로 두면 .env의 KLAC_GEMINI_MODEL이 반영되지 않는다.
    model_name = model_name or os.environ.get("KLAC_GEMINI_MODEL") or FALLBACK_MODEL
    client = _get_client()
    contents = build_contents(consultation_text)

    last_error: str | None = None
    raw_content: str = ""

    for attempt in range(max_retries + 1):
        if last_error:
            # 검증 실패 시 모델 답변과 피드백을 이어서 전달
            current_contents = contents + [
                {"role": "model", "parts": [{"text": raw_content}]},
                {
                    "role": "user",
                    "parts": [
                        {
                            "text": (
                                f"방금 출력이 Pydantic 스키마 검증에 실패했습니다: {last_error}\n"
                                "반드시 아래 9개 필드를 하나도 빠짐없이 완벽한 JSON으로 출력하세요:\n"
                                "- summary, case_type, case_subtype, urgency_level, eligibility\n"
                                "- extracted_json, missing_info_json, checklist_json, timeline_json"
                            )
                        }
                    ],
                },
            ]
        else:
            current_contents = contents

        # 정제된 Gemini 전용 스키마 전달
        config = types.GenerateContentConfig(
            system_instruction=SYSTEM_PROMPT,
            response_mime_type="application/json",
            response_schema=_GEMINI_CLEANED_SCHEMA,
            temperature=0.1,
            # 2048이면 응답이 중간에 잘려 "Invalid JSON: EOF while parsing"으로 검증에 실패한다.
            # gemini 3.x는 내부 추론 토큰도 이 예산에서 함께 쓰기 때문에 여유를 둔다.
            max_output_tokens=8192,
        )

        response = _generate_with_retry(client, model_name, current_contents, config)

        raw_content = response.text

        try:
            return AIAnalysisSchema.model_validate_json(raw_content)
        except ValidationError as e:
            last_error = str(e)
            if attempt == max_retries:
                raise

    raise RuntimeError("unreachable")