"""이름이 아닌 값이 서식의 이름칸에 들어가지 않는지.

서식은 법원·관공서에 내는 문서다. 이름칸에 없는 사람 이름이 찍히면 그건 오기이고,
상담원이 그걸 알아보지 못하면 그대로 나간다. 모르면 비워 두고 누락자료로 남기는 것이
이 프로젝트의 규칙이다.

실제로 두 번 뚫렸다.
  1차: 프론트가 화면 표시용 문구 '이름 미입력'을 clientName으로 저장 →
       "청구인(상속인) 이름 미입력"이 인쇄됨
  2차: @NotBlank를 통과시키려고 '아무개'를 저장 →
       출생신고서의 부·모 칸에 "아무개"가 인쇄됨

2차가 더 나빴던 이유가 이 파일의 존재 이유다. '아무개'는 한글 세 글자 사람 이름
모양이라 형태로는 진짜 이름과 구별되지 않는다. 지금은 프론트가 빈 값을 보내도록
고쳤지만, 그 전에 저장된 상담이 남아 있어 여기서도 한 겹 막는다.
"""

from app.ai.forms.drafter import _is_person_name, _seed_role_names


class TestNotAName:
    """이름칸에 넣으면 안 되는 값들."""

    def test_지어낸_이름은_이름이_아니다(self):
        # 형태만 보면 진짜 이름과 구별되지 않는 값. 목록으로 막는 수밖에 없다.
        assert not _is_person_name("아무개")
        assert not _is_person_name(" 아무개 ")

    def test_화면_표시용_문구는_이름이_아니다(self):
        assert not _is_person_name("이름 미입력")
        assert not _is_person_name("미입력")

    def test_확인_못했다는_표시는_이름이_아니다(self):
        for value in ("미상", "불명", "확인불가", "알 수 없음", "없음"):
            assert not _is_person_name(value), value

    def test_지칭어는_이름이_아니다(self):
        # 분석이 이름을 못 들었을 때 이름 자리에 넣는 말들.
        for value in ("첫째", "장남", "본인", "배우자", "미성년 자녀"):
            assert not _is_person_name(value), value

    def test_한_칸에_여럿을_몰아넣은_값은_이름이_아니다(self):
        assert not _is_person_name("첫째, 둘째")
        assert not _is_person_name("김철수/이영희")


class TestRealName:
    """진짜 이름은 막히면 안 된다. 위 목록이 넓어지면 여기가 깨진다."""

    def test_보통의_한국_이름은_통과한다(self):
        for value in ("문가영", "김철수", "남기훈", "황보름", "선우재덕"):
            assert _is_person_name(value), value

    def test_망_표시가_붙어도_이름으로_읽는다(self):
        assert _is_person_name("망 이재호")


class TestSeedRoleNames:
    """접수 때 적어둔 이름이 서식의 역할칸으로 넘어가는 경로.

    우선순위는 접수 때 적어둔 값 > 추출정보 > GPT 추론이다. 앞의 둘은 사람이
    확인한 값이고 마지막만 추론이라 사람 손을 거친 쪽이 이긴다 — 맞는 설계다.

    다만 그 전제가 깨지면 우선순위가 그대로 흉기가 된다. 아무도 입력한 적 없는
    값이 '사람이 확인한 값' 자리에 앉으면 맞는 이름을 밀어내기 때문이다.
    """

    # 실제 사고 그대로. 상담 106의 분석은 신청인을 "임수정"으로 정확히 뽑아냈는데,
    # DB의 clientName에는 프론트가 채워 넣은 "아무개"가 들어 있었다. 우선순위 규칙에
    # 따라 아무개가 임수정을 밀어냈고, 출생신고서의 부·모 칸에 "아무개"가 인쇄됐다.
    출생신고_분석 = {"당사자": [{"역할": "신청인", "이름": "임수정"},
                          {"역할": "자녀", "이름": "이마율"},
                          {"역할": "상대방(아이 아버지)", "이름": "미상"}]}

    def test_자리표시자가_분석이_찾은_이름을_밀어내지_않는다(self):
        seeded = _seed_role_names("아무개", "", self.출생신고_분석)
        assert seeded["청구인"] == "임수정"

    def test_예전_자리표시자도_마찬가지다(self):
        # '이름 미입력'은 _apply_confirmed_names_to_extracted에서만 막고 있었고
        # 이 경로로는 그대로 통과했다.
        for placeholder in ("이름 미입력", "미입력", "미상"):
            seeded = _seed_role_names(placeholder, "", self.출생신고_분석)
            assert seeded["청구인"] == "임수정", placeholder

    def test_접수한_이름이_추출정보보다_우선한다(self):
        # 진짜 이름은 여전히 이긴다. 위 검사가 이걸 막으면 안 된다.
        seeded = _seed_role_names(
            applicant_name="문가영",
            opponent_name="",
            extracted={"청구인": "문경"},  # STT가 잘못 들은 값
        )
        assert seeded["청구인"] == "문가영"

    def test_이름이_비어_있으면_추출정보를_쓴다(self):
        # 통화 중 접수처럼 이름을 아직 모르는 상담이 정상이다. 그때는 분석이
        # 뽑아낸 당사자 목록이 유일한 확정 출처다.
        seeded = _seed_role_names(applicant_name="", opponent_name="",
                                  extracted={"청구인": "문가영"})
        assert seeded["청구인"] == "문가영"

    def test_양쪽_다_없으면_아무것도_정하지_않는다(self):
        # 여기서 무언가를 채우면 그게 서식에 인쇄된다. 비워 두는 것이 맞다.
        assert _seed_role_names(applicant_name="", opponent_name="", extracted={}) == {}
        assert _seed_role_names(applicant_name=None, opponent_name=None, extracted=None) == {}
