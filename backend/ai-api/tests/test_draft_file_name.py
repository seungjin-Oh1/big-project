"""초안 파일 이름에 청구인 이름이 붙는지.

파일 이름만 보고 누구 것인지 알 수 있어야 한다는 요구에서 나왔다. 이름을 못 믿는
경우(빈 값, 화면 문구가 저장된 상담)에 예전 이름으로 돌아가는 것과, 이름이 경로로
쓰일 수 없게 깎이는 것을 함께 확인한다.
"""

from app.ai.forms.drafter import _draft_file_stem

FORM = "이행명령신청서(면접교섭)"


def test_prefixes_applicant_name():
    assert _draft_file_stem(FORM, "한소영") == f"한소영_{FORM}_초안"


def test_trims_surrounding_spaces():
    assert _draft_file_stem(FORM, "  한소영  ") == f"한소영_{FORM}_초안"


def test_keeps_old_name_when_applicant_is_missing():
    for empty in ("", "   ", None):
        assert _draft_file_stem(FORM, empty) == f"{FORM}_초안"


def test_keeps_old_name_for_placeholder_values():
    # 프론트가 빈 이름 자리에 넣던 화면 문구가 clientName으로 저장된 상담이 남아 있다.
    for placeholder in ("이름 미입력", "아무개", "미상", "첫째, 둘째"):
        assert _draft_file_stem(FORM, placeholder) == f"{FORM}_초안"


def test_strips_path_characters_from_name():
    # 이름은 사람이 화면에서 입력한 값이라 그대로 파일 경로에 넣을 수 없다.
    stem = _draft_file_stem(FORM, r"..\..\etc")
    assert "/" not in stem and "\\" not in stem and ".." not in stem
