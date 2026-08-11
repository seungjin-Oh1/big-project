import { useState } from 'react';
import { BadgeCheck, Clock, FileText, ShieldCheck, Eye, EyeOff } from 'lucide-react';
import { roleOptions, today } from '../constants.jsx';
import { caseCategories, legalAidBranchOffices } from '../data/domain.js';

function formatDotDate(isoDate) {
  return isoDate.replaceAll('-', '.');
}

// ── 비밀번호 작성규칙 ──
//
// "개인정보의 기술적·관리적 보호조치 기준" 제4조 ⑧항이 요구하는 구성입니다.
//   1. 영문·숫자·특수문자 중 2종류 이상 조합 시 10자리 이상
//      3종류 이상 조합 시 8자리 이상
//   2. 아이디와 비슷한 비밀번호는 사용하지 않을 것
//
// 같은 규칙을 core-api(AuthService)에서도 검사합니다. 화면 검사만 두면 API를 직접 부르는
// 경로로 규칙을 지나칠 수 있어, 안내는 여기서 하고 실제 차단은 서버에서 합니다.
export const PASSWORD_RULE_TEXT = '영문·숫자·특수문자 중 2종류 이상 10자리, 또는 3종류를 모두 섞어 8자리 이상';

export function validatePassword(password = '', email = '') {
  if (!password) return '';
  const kindCount = [/[A-Za-z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((pattern) => pattern.test(password)).length;
  const longEnough = (kindCount >= 3 && password.length >= 8) || (kindCount >= 2 && password.length >= 10);
  if (!longEnough) return `${PASSWORD_RULE_TEXT}으로 만들어주세요.`;

  // 아이디(이메일 앞부분)를 그대로 넣은 비밀번호는 추측이 쉬워 규칙 2항에서 막습니다.
  const localPart = (email.split('@')[0] || '').trim();
  if (localPart.length >= 3 && password.toLowerCase().includes(localPart.toLowerCase())) {
    return '이메일 아이디가 그대로 들어간 비밀번호는 사용할 수 없습니다.';
  }
  return '';
}

// 지부와 부서를 하나의 소속 문자열로 합칩니다. 회원가입·비밀번호 찾기·프로필이 모두 이 규칙을 따라야
// 관리자가 가입 기록과 대조할 때 표기가 어긋나지 않습니다.
function buildOrganization(branch, department) {
  const trimmedDepartment = (department || '').trim();
  return trimmedDepartment ? `${branch} / ${trimmedDepartment}` : branch;
}

// 비밀번호 칸에 표시/숨김 토글을 붙입니다. 타이핑한 값을 확인할 방법이 없어 오타로 로그인·가입이
// 반복 실패하는 문제를 줄이기 위한 것으로, 로그인·회원가입의 비밀번호 입력칸 전부가 같은 방식을 씁니다.
function PasswordInput({ value, onChange, placeholder, ariaInvalid, ariaDescribedby }) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="passwordFieldControl">
      <input
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        aria-invalid={ariaInvalid}
        aria-describedby={ariaDescribedby}
      />
      <button
        type="button"
        className="passwordVisibilityToggle"
        onClick={() => setVisible((current) => !current)}
        aria-label={visible ? '비밀번호 숨기기' : '비밀번호 표시'}
        aria-pressed={visible}
      >
        {visible ? <EyeOff size={16} strokeWidth={2.2} aria-hidden="true" /> : <Eye size={16} strokeWidth={2.2} aria-hidden="true" />}
      </button>
    </div>
  );
}

function LoginPage({ loginForm, loginError, loginNotice, loginPending, rememberId, onRememberChange, onLoginChange, onRegister, onForgotPassword, onQuickLogin, consultations = [] }) {
  const inProgressCount = consultations.filter((item) => item.status === '진행 중').length;
  const onHoldCount = consultations.filter((item) => item.status === '보류').length;
  const completedCount = consultations.filter((item) => item.status === '완료').length;
  const maxPreviewCount = Math.max(inProgressCount, onHoldCount, completedCount, 1);
  return (
    <div className="screen loginScreen">
      <div className="loginSplit">
        <section className="loginHeroPanel" aria-labelledby="main-copy-title">
          <video
            className="loginHeroVideo"
            src="/login-hero.mp4"
            autoPlay
            loop
            muted
            playsInline
            aria-hidden="true"
          />
          <div className="loginHeroOverlay" aria-hidden="true" />
          <div className="loginHeroContentPanel">
            <div className="loginHeroCopy">
              <div className="loginHeroBrand" aria-label="서비스명: AI LAW 아이로">
                <span className="loginHeroBrandMark">AI LAW</span>
                <span className="loginHeroBrandSub">아이로</span>
              </div>
              <p className="loginHeroOrgLine">대한법률구조공단 AI 통합업무 지원 시스템</p>
              <h1 id="main-copy-title">
                <span>상담부터 변호사 검토까지,</span>
                <span>한 흐름으로 연결합니다.</span>
              </h1>
              <p>실시간 상담 · 자료 정리 · 서식 초안 · 검토 전달</p>
              <p className="loginHeroCredit">
                <strong>KT AIVLE School</strong>
                <span aria-hidden="true">·</span>
                <strong className="loginHeroTeamName">AI트랙 수도권 01반 01조</strong>
                <span aria-hidden="true">·</span>
                <strong>법이음 서비스</strong>
              </p>
            </div>
            <div className="heroFeatureGrid" aria-label="주요 지원 기능">
              <span><FileText size={16} /> 통화 메모 바로 정리</span>
              <span><ShieldCheck size={16} /> 검토 누락 줄이기</span>
            </div>
            <div className="heroScopeNotice" aria-label="현재 지원하는 사건 범위">
              <p className="heroScopeLabel">현재 지원 범위 · 가사법 4대 분류</p>
              <div className="heroScopeChips">
                {caseCategories.map((category) => <span className="heroScopeChip" key={category.key}>{category.key}</span>)}
              </div>
              <p className="heroScopeText">
                가사법 4대 분류 · 전국 {legalAidBranchOffices.length}개 지부 우선 운영
              </p>
            </div>
            {/* 점·막대는 장식이라 각자 aria-hidden으로 숨기지만, 라벨·수치(진행 중 3건 등)는
                실제 정보라 카드 전체를 가리지 않고 그대로 읽히게 둡니다. */}
            <div className="heroPreviewCard">
              <div className="heroPreviewHeader">
                <strong>오늘의 상담 현황</strong>
                <span className="heroPreviewDate">{formatDotDate(today)}</span>
              </div>
              {/* 상태별 색 점·라벨·막대·건수를 한 줄에 보여줘 상담 현황을 빠르게 비교합니다. */}
              {consultations.length ? (
                <div className="heroPreviewStats">
                  <div className="heroPreviewStat">
                  <span className="heroPreviewStatDot tone-info" aria-hidden="true" />
                  <span className="heroPreviewStatLabel">진행 중</span>
                  <span className="heroPreviewBarTrack" aria-hidden="true"><span className="heroPreviewBarFill tone-info" style={{ width: `${(inProgressCount / maxPreviewCount) * 100}%` }} /></span>
                  <span className="heroPreviewStatValue">{inProgressCount}건</span>
                </div>
                <div className="heroPreviewStat">
                  <span className="heroPreviewStatDot tone-warn" aria-hidden="true" />
                  <span className="heroPreviewStatLabel">보류</span>
                  <span className="heroPreviewBarTrack" aria-hidden="true"><span className="heroPreviewBarFill tone-warn" style={{ width: `${(onHoldCount / maxPreviewCount) * 100}%` }} /></span>
                  <span className="heroPreviewStatValue">{onHoldCount}건</span>
                </div>
                <div className="heroPreviewStat">
                  <span className="heroPreviewStatDot tone-success" aria-hidden="true" />
                  <span className="heroPreviewStatLabel">완료</span>
                  <span className="heroPreviewBarTrack" aria-hidden="true"><span className="heroPreviewBarFill tone-success" style={{ width: `${(completedCount / maxPreviewCount) * 100}%` }} /></span>
                  <span className="heroPreviewStatValue">{completedCount}건</span>
                </div>
                </div>
              ) : <p className="heroPreviewEmpty">상담 데이터 없음</p>}
            </div>
            <p className="loginHeroNote">대한법률구조공단 내부 상담 업무 보조 시스템</p>
          </div>
        </section>

        <section className="loginFormPanel" aria-labelledby="login-title">
          <div className="loginIntro">
            <h2 id="login-title">업무 포털 로그인</h2>
            <p>기관 이메일로 로그인하세요. 승인된 계정만 이용할 수 있습니다.</p>
          </div>
          <section className="loginCard">
            <label className="field">
              <span>이메일</span>
              <input
                type="email"
                value={loginForm.email}
                onChange={(event) => onLoginChange('email', event.target.value)}
                placeholder="name@email.or.kr"
              />
            </label>
            <label className="field">
              <span>비밀번호</span>
              <PasswordInput
                value={loginForm.password}
                onChange={(event) => onLoginChange('password', event.target.value)}
                placeholder="비밀번호 입력"
              />
            </label>
            <label className="rememberRow">
              <input type="checkbox" checked={rememberId} onChange={(event) => onRememberChange(event.target.checked)} />
              <span>아이디 저장</span>
            </label>
            {!loginError && loginNotice ? <p className="formNotice">{loginNotice}</p> : null}
            {loginError ? <p className="formError">{loginError}</p> : null}
            <button className="primaryButton" type="submit" form="login-form" disabled={loginPending}>{loginPending ? '로그인하는 중…' : '로그인'}</button>
            <div className="loginLinks">
              <button type="button" className="loginLinkMuted" onClick={onForgotPassword}>비밀번호 찾기</button>
              <button type="button" className="loginLinkPrimary" onClick={onRegister}>처음이신가요? <span>회원가입</span></button>
            </div>
          </section>
          {onQuickLogin ? (
            <section className="loginCard quickLoginCard">
              <div className="sectionLabel">시연용 빠른 시작 <span className="quickLoginBadge">테스트용</span></div>
              <p className="helperText">사용할 역할을 선택하면 바로 화면을 확인할 수 있습니다.</p>
              <div className="roleGrid quickLoginGrid">
                {roleOptions.map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      className={`roleCard ${item.tone}`}
                      onClick={() => onQuickLogin(item.key)}
                    >
                      <Icon size={24} strokeWidth={2.2} />
                      <span><strong>{item.title}</strong><small>{item.detail}</small></span>
                    </button>
                  );
                })}
              </div>
            </section>
          ) : null}
        </section>
      </div>
    </div>
  );
}

function RegisterPage({ onComplete, onBack, registerError = '', registerPending = false }) {
  const [role, setRole] = useState('counselor');
  const [form, setForm] = useState({ name: '', organization: '', department: '', phone: '', branch: legalAidBranchOffices[0], email: '', password: '', confirmPassword: '' });
  // 개인정보 보호법 제15조 제2항 — 수집·이용에 대한 동의는 받아야 가입을 진행할 수 있습니다.
  // 동의 여부는 가입 요청에 함께 실려 서버에 동의 시각(users.privacy_agreed_at)으로 남습니다.
  // 분쟁이 생기면 그 값이 "동의를 받았다"는 증빙이 됩니다.
  const [privacyAgreed, setPrivacyAgreed] = useState(false);
  const emailInvalid = form.email.length > 0 && !form.email.includes('@');
  const passwordsMismatch = form.confirmPassword && form.password !== form.confirmPassword;
  const passwordRuleError = validatePassword(form.password, form.email);
  // 관리자는 본부 소속이라 지부 선택이 필요 없고, 상담원/변호사는 자유롭게 소속기관을 입력하는 대신
  // 반드시 실제 지부 목록 중에서만 소속을 고르도록 합니다(오타·허위 소속 입력 방지).
  // 지부 안에서 어느 부서인지는 목록으로 못 박기 어려워 직접 입력받습니다.
  const requiresBranch = role !== 'admin';
  const isSubmitDisabled = !form.name || (requiresBranch ? (!form.branch || !form.department) : !form.organization) || !form.phone || !form.email || emailInvalid || !form.password || !form.confirmPassword || passwordsMismatch || Boolean(passwordRuleError) || !privacyAgreed || registerPending;

  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  // 입력칸에서 Enter를 눌러도 가입이 되도록 form의 submit으로 받습니다.
  // (버튼 클릭만 받으면 로그인 화면과 조작법이 달라져 사용자가 헷갈립니다)
  const submit = (event) => {
    event?.preventDefault();
    if (isSubmitDisabled) return;
    // 상담원/변호사의 소속은 '선택한 지부 + 입력한 부서'를 합쳐 하나의 문자열로 보관합니다.
    // (헤더 배지·관리자 계정 목록 등 기존 화면이 organization 한 필드를 그대로 쓰고 있어 호환을 유지합니다)
    const organization = requiresBranch ? buildOrganization(form.branch, form.department) : form.organization;
    // 관리자는 지부 선택 UI 자체가 없는데도 form.branch가 초기값(legalAidBranchOffices[0])으로
    // 남아 있어서, 이 값을 그대로 넘기면 헤더 배지(layout.jsx formatIdentityBadge)가
    // currentUser.branch를 "관리자가 실제로 고른 지부"로 오인해 organization 대신
    // 엉뚱한 지부명을 보여줬습니다. 관리자는 branch를 비워서 넘깁니다.
    onComplete({ ...form, role, organization, branch: requiresBranch ? form.branch : '', privacyAgreed });
  };

  return (
    <div className="screen">
      <div className="content registerContent">
        <form className="registerCard" aria-labelledby="register-title" onSubmit={submit}>
          <div className="registerIntro">
            <span>계정 신청</span>
            <h1 id="register-title">회원가입</h1>
            <ul className="loginIntroList compact">
              <li>역할 선택</li>
              <li>기본 정보 입력</li>
              <li>관리자 승인 후 사용</li>
            </ul>
          </div>
          <section className="roleSelectionPanel" aria-labelledby="role-selection-title">
            <div className="sectionLabel" id="role-selection-title">권한 선택</div>
            <p className="helperText">사용할 역할을 선택하면 해당 업무 화면으로 시작합니다.</p>
            <div className="roleGrid roleSelectionGrid">
              {roleOptions.map((item) => {
                const Icon = item.icon;
                return (
                  <button className={`roleCard ${item.tone}${role === item.key ? ' selected' : ''}`} type="button" key={item.key} onClick={() => setRole(item.key)} aria-pressed={role === item.key}>
                    <Icon size={24} strokeWidth={2.2} />
                    <span><strong>{item.title}</strong><small>{item.detail}</small></span>
                  </button>
                );
              })}
            </div>
          </section>
          <div className="sectionLabel">기본 정보</div>
          <div className="formGrid">
            <label className="field"><span>이름</span><input value={form.name} onChange={(e) => update('name', e.target.value)} placeholder="홍길동" /></label>
            {requiresBranch ? (
              <label className="field">
                <span>소속기관 (지부)</span>
                <select value={form.branch} onChange={(e) => update('branch', e.target.value)}>
                  {legalAidBranchOffices.map((branch) => <option key={branch} value={branch}>{branch}</option>)}
                </select>
              </label>
            ) : (
              <label className="field"><span>소속지부 / 부서</span><input value={form.organization} onChange={(e) => update('organization', e.target.value)} placeholder="대한법률구조공단 / 전산" /></label>
            )}
          </div>
          {requiresBranch ? (
            <label className="field">
              <span>부서</span>
              <input value={form.department} onChange={(e) => update('department', e.target.value)} placeholder="예) 법률구조1부" />
            </label>
          ) : null}
          <label className="field">
            <span>연락처</span>
            <input value={form.phone} onChange={(e) => update('phone', e.target.value)} type="tel" placeholder="010-0000-0000" />
          </label>
          <label className="field">
            <span>이메일</span>
            <input
              value={form.email}
              onChange={(e) => update('email', e.target.value)}
              type="email"
              placeholder="name@email.or.kr"
              aria-invalid={emailInvalid}
              aria-describedby={emailInvalid ? 'register-email-error' : undefined}
            />
          </label>
          {emailInvalid ? <p className="formError" id="register-email-error">이메일에 @를 포함해주세요.</p> : null}
          <div className="formGrid">
            <label className="field">
              <span>비밀번호</span>
              <PasswordInput
                value={form.password}
                onChange={(e) => update('password', e.target.value)}
                placeholder="비밀번호 입력"
                ariaInvalid={Boolean(passwordRuleError)}
                ariaDescribedby="register-password-rule"
              />
            </label>
            <label className="field">
              <span>비밀번호 확인</span>
              <PasswordInput value={form.confirmPassword} onChange={(e) => update('confirmPassword', e.target.value)} placeholder="비밀번호 확인" />
            </label>
          </div>
          {/* 규칙은 입력 전에도 보이게 항상 띄웁니다. 틀린 뒤에야 알려주면 몇 번씩 다시 만들게 됩니다. */}
          <p className="fieldHint" id="register-password-rule">{PASSWORD_RULE_TEXT}</p>
          {passwordRuleError ? <p className="formError">{passwordRuleError}</p> : null}
          {passwordsMismatch ? <p className="formError">비밀번호와 비밀번호 확인이 일치하지 않습니다.</p> : null}

          <div className="sectionLabel">개인정보 수집 및 이용 동의</div>
          <div className="consentCard">
            <div className="consentTableWrap">
              <table className="consentTable">
                <thead>
                  <tr><th scope="col">수집 항목</th><th scope="col">이용 목적</th><th scope="col">보유 기간</th></tr>
                </thead>
                <tbody>
                  <tr>
                    <td>이름, 이메일, 연락처, 소속(지부·부서)</td>
                    <td>상담원·변호사 계정 발급 및 권한 관리</td>
                    <td>퇴직 또는 탈퇴 시까지</td>
                  </tr>
                </tbody>
              </table>
            </div>
            {/* 법 제15조 제2항 4호 — 거부할 권리와 거부 시 불이익을 함께 알려야 합니다. */}
            <p className="consentNotice">
              동의를 거부하실 수 있습니다. 다만 위 항목은 계정 발급에 반드시 필요해, 거부하시면 가입을 진행할 수 없습니다.
            </p>
            <label className="consentCheck">
              <input type="checkbox" checked={privacyAgreed} onChange={(e) => setPrivacyAgreed(e.target.checked)} />
              <span><strong>[필수]</strong> 개인정보 수집 및 이용에 동의합니다.</span>
            </label>
            <p className="consentNotice">
              보관·파기 절차 등 자세한 내용은 <a href="/privacy.html" target="_blank" rel="noreferrer">개인정보 처리방침</a>에서 확인하실 수 있습니다.
            </p>
          </div>
          {/* 관리자는 바로 쓸 수 있으니 단순 안내(파랑), 상담원·변호사는 승인까지 기다려야 하니 주의(주황)로 구분합니다. */}
          <div className={role === 'admin' ? 'notice' : 'notice warn'}>
            {role === 'admin' ? <BadgeCheck size={18} /> : <Clock size={18} />}
            <p>
              {role === 'admin'
                ? '관리자는 가입 후 바로 사용할 수 있습니다.'
                : '관리자 승인 후 로그인할 수 있습니다. 결과는 이메일로 안내됩니다.'}
            </p>
          </div>
          {registerError ? <p className="formError">{registerError}</p> : null}
          <button className="primaryButton submitButton" type="submit" disabled={isSubmitDisabled}>{registerPending ? '가입 신청하는 중…' : '가입 신청하기'}</button>
          {onBack ? <button className="secondaryFullButton" type="button" onClick={onBack}>로그인으로 돌아가기</button> : null}
        </form>
      </div>
    </div>
  );
}

// 연락처는 사람마다 '010-1234-5678', '01012345678', '010 1234 5678'처럼 다르게 적어서
// 글자 그대로 비교하면 본인인데도 불일치로 막힙니다. 숫자만 남겨 비교합니다.
function normalizePhone(value) {
  return (value || '').replace(/\D/g, '');
}

function PasswordFindPage({ users, onBack }) {
  const [step, setStep] = useState('verify');
  const [form, setForm] = useState({ name: '', branch: legalAidBranchOffices[0], department: '', phone: '', email: '', contact: '' });
  const [message, setMessage] = useState('');
  const [verifiedUser, setVerifiedUser] = useState(null);
  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const isVerifyDisabled = !form.name || !form.branch || !form.department || !form.phone || !form.email;

  const verify = (event) => {
    event.preventDefault();
    if (isVerifyDisabled) {
      setMessage('본인 확인 항목을 모두 입력해주세요.');
      return;
    }
    // 관리자가 가입 기록과 대조하는 기준입니다. 회원가입 때와 같은 방식(지부 + 부서)으로 소속을 만들어
    // 표기가 어긋나지 않게 맞춘 뒤, 이름·소속·연락처·이메일이 모두 일치해야 통과시킵니다.
    const requestedOrganization = buildOrganization(form.branch, form.department);
    const matched = users.find((user) => (
      user.name === form.name.trim()
      && user.organization === requestedOrganization
      && user.email === form.email.trim()
      && normalizePhone(user.phone) === normalizePhone(form.phone)
    ));
    if (!matched) {
      setMessage('가입 기록 없음 · 입력 정보 확인');
      return;
    }
    setMessage('');
    setVerifiedUser(matched);
    setStep('contact');
  };

  return (
    <div className="screen">
      <div className="content registerContent">
        <section className="registerCard passwordCard" aria-labelledby="password-title">
          <div className="registerIntro">
            <span>비밀번호 재설정</span>
            <h1 id="password-title">비밀번호 찾기</h1>
            <ul className="loginIntroList compact">
              <li>가입 정보 입력</li>
              <li>계정 확인</li>
              <li>임시 비밀번호 요청</li>
            </ul>
          </div>
          {/* "비밀번호 찾기"라는 제목만 보고 이 화면에서 바로 새 비밀번호를 정할 수 있다고
              오해하기 쉬워, 실제로는 본인 확인 후 관리자가 임시 비밀번호를 전달하는 절차임을
              맨 위에서 먼저 알려 기대치를 맞춥니다. */}
          <div className="notice passwordNotice primary">
            <p>이 화면에서 바로 비밀번호를 재설정할 수는 없습니다. 본인 확인 후 관리자가 임시 비밀번호를 전달합니다.</p>
          </div>
          {step === 'verify' ? (
            <form onSubmit={verify}>
              <div className="sectionLabel">본인 확인</div>
              <label className="field"><span>이름</span><input value={form.name} onChange={(e) => update('name', e.target.value)} placeholder="이름 입력" /></label>
              {/* 회원가입과 똑같이 지부는 목록에서 고르고 부서는 직접 입력받습니다. 자유 입력이면 표기가 달라져 대조가 실패합니다. */}
              <label className="field">
                <span>소속기관 (지부)</span>
                <select value={form.branch} onChange={(e) => update('branch', e.target.value)}>
                  {legalAidBranchOffices.map((branch) => <option key={branch} value={branch}>{branch}</option>)}
                </select>
              </label>
              <label className="field"><span>부서</span><input value={form.department} onChange={(e) => update('department', e.target.value)} placeholder="예) 법률구조1부" /></label>
              <label className="field"><span>연락처</span><input value={form.phone} onChange={(e) => update('phone', e.target.value)} type="tel" placeholder="010-0000-0000" /></label>
              <label className="field"><span>이메일</span><input value={form.email} onChange={(e) => update('email', e.target.value)} type="email" placeholder="이메일 입력" /></label>
              {message ? <p className="formError">{message}</p> : null}
              <button className="primaryButton" type="submit" disabled={isVerifyDisabled}>회원 정보 확인 요청</button>
            </form>
          ) : (
            <form onSubmit={(event) => event.preventDefault()}>
              <p className="helperText success">계정을 확인했습니다. 받을 연락처를 입력해주세요.</p>
              {/* 어떤 계정으로 확인됐는지 보여줘, 동명이인이 있을 때 엉뚱한 계정으로 진행하는 것을 막습니다. */}
              <div className="verifiedAccountBox">
                <span>확인된 계정</span>
                <strong>{verifiedUser?.name} · {verifiedUser?.organization}</strong>
                <em>{verifiedUser?.email}</em>
              </div>
              <label className="field"><span>연락처</span><input value={form.contact} onChange={(e) => update('contact', e.target.value)} placeholder="휴대폰 번호 또는 이메일" /></label>
              <button className="primaryButton" type="button" disabled={!form.contact} onClick={() => setMessage('관리자 확인 후 임시 비밀번호를 전달합니다.')}>임시 비밀번호 요청</button>
              {message ? <p className="helperText success">{message}</p> : null}
            </form>
          )}
          <button className="secondaryFullButton" type="button" onClick={onBack}>로그인으로 돌아가기</button>
        </section>
      </div>
    </div>
  );
}

export { LoginPage, RegisterPage, PasswordFindPage };
