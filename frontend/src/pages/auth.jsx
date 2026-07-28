import React, { useState } from 'react';
import { BadgeCheck, Clock, FileText, ShieldCheck } from 'lucide-react';
import { roleOptions } from '../constants.jsx';
import { caseCategories, legalAidBranchOffices } from '../data/domain.js';

// 지부와 부서를 하나의 소속 문자열로 합칩니다. 회원가입·비밀번호 찾기·프로필이 모두 이 규칙을 따라야
// 관리자가 가입 기록과 대조할 때 표기가 어긋나지 않습니다.
function buildOrganization(branch, department) {
  const trimmedDepartment = (department || '').trim();
  return trimmedDepartment ? `${branch} / ${trimmedDepartment}` : branch;
}

function LoginPage({ loginForm, loginError, loginNotice, loginPending, rememberId, onRememberChange, onLoginChange, onRegister, onForgotPassword, onQuickLogin, consultations = [] }) {
  const inProgressCount = consultations.filter((item) => item.status === '진행 중').length;
  const onHoldCount = consultations.filter((item) => item.status === '보류').length;
  const completedCount = consultations.filter((item) => item.status === '완료').length;
  const maxCount = Math.max(1, inProgressCount, onHoldCount, completedCount);
  return (
    <div className="screen loginScreen">
      <div className="loginSplit">
        <section className="loginHeroPanel" aria-labelledby="main-copy-title">
          <div className="loginHeroTop">
            <span className="heroBadge"><img src="/brand-mark.png" alt="" aria-hidden="true" /> 공단 업무 지원</span>
          </div>
          <div className="loginHeroCopy">
            <p className="heroEyebrow">법률구조 상담 지원 포털</p>
            <h1 id="main-copy-title">
              상담 기록부터 서식 초안까지,
              <span>인공지능이 함께 정리합니다</span>
            </h1>
            <p>
              상담원이 입력한 기록과 첨부자료를 바탕으로 사건 유형, 누락자료,<br />
              검토 체크리스트와 서식 초안을 한 화면에서 확인할 수 있도록 돕습니다.
            </p>
          </div>
          <div className="heroFeatureGrid" aria-label="주요 지원 기능">
            <span><FileText size={16} /> 상담 내용 구조화</span>
            <span><ShieldCheck size={16} /> 검토 항목 확인</span>
          </div>
          <div className="heroScopeNotice" aria-label="현재 지원하는 사건 범위">
            <p className="heroScopeLabel">현재 지원 범위 · 가사법 4대 분류</p>
            <div className="heroScopeChips">
              {caseCategories.map((category) => <span className="heroScopeChip" key={category.key}>{category.key}</span>)}
            </div>
            <p className="heroScopeText">
              가사법 4대 분류와 전국 {legalAidBranchOffices.length}개 지부({legalAidBranchOffices[0]}~{legalAidBranchOffices[legalAidBranchOffices.length - 1]})<br />
              상담원·변호사를 대상으로 우선 운영되며, 이후 순차 확대될 예정입니다.
            </p>
          </div>
          <div className="heroPreviewCard" aria-hidden="true">
            <div className="heroPreviewHeader">
              <span className="heroPreviewDots"><i /><i /><i /></span>
              <strong>오늘의 상담 현황</strong>
            </div>
            {consultations.length ? (
              <div className="heroPreviewStats">
                <div className="heroPreviewStat">
                  <span className="heroPreviewStatLabel">진행 중</span>
                  <div className="heroPreviewBarTrack"><div className="heroPreviewBar tone-info" style={{ width: `${Math.max(4, (inProgressCount / maxCount) * 100)}%` }} /></div>
                  <span className="heroPreviewStatValue">{inProgressCount}건</span>
                </div>
                <div className="heroPreviewStat">
                  <span className="heroPreviewStatLabel">보류</span>
                  <div className="heroPreviewBarTrack"><div className="heroPreviewBar tone-warn" style={{ width: `${Math.max(4, (onHoldCount / maxCount) * 100)}%` }} /></div>
                  <span className="heroPreviewStatValue">{onHoldCount}건</span>
                </div>
                <div className="heroPreviewStat">
                  <span className="heroPreviewStatLabel">완료</span>
                  <div className="heroPreviewBarTrack"><div className="heroPreviewBar tone-success" style={{ width: `${Math.max(4, (completedCount / maxCount) * 100)}%` }} /></div>
                  <span className="heroPreviewStatValue">{completedCount}건</span>
                </div>
              </div>
            ) : <p className="heroPreviewEmpty">등록된 상담 데이터가 아직 없습니다.</p>}
          </div>
          <p className="loginHeroNote">대한법률구조공단 내부 상담 업무 보조 시스템</p>
        </section>

        <section className="loginFormPanel" aria-labelledby="login-title">
          <div className="loginIntro">
            <span>로그인</span>
            <h2 id="login-title">업무 시스템에 로그인하세요</h2>
            <p>계정이 있으면 이메일과 비밀번호로 로그인하세요. 계정이 없다면 회원가입 후 관리자 승인을 기다려주세요.</p>
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
              <input
                type="password"
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
              <div className="sectionLabel">테스트용 빠른 로그인</div>
              <p className="helperText">기능 테스트를 위해 권한을 선택하면 계정 없이 바로 접속합니다.</p>
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
  const emailInvalid = form.email.length > 0 && !form.email.includes('@');
  const passwordsMismatch = form.confirmPassword && form.password !== form.confirmPassword;
  // 관리자는 본부 소속이라 지부 선택이 필요 없고, 상담원/변호사는 자유롭게 소속기관을 입력하는 대신
  // 반드시 실제 지부 목록 중에서만 소속을 고르도록 합니다(오타·허위 소속 입력 방지).
  // 지부 안에서 어느 부서인지는 목록으로 못 박기 어려워 직접 입력받습니다.
  const requiresBranch = role !== 'admin';
  const isSubmitDisabled = !form.name || (requiresBranch ? (!form.branch || !form.department) : !form.organization) || !form.phone || !form.email || emailInvalid || !form.password || !form.confirmPassword || passwordsMismatch || registerPending;

  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  // 입력칸에서 Enter를 눌러도 가입이 되도록 form의 submit으로 받습니다.
  // (버튼 클릭만 받으면 로그인 화면과 조작법이 달라져 사용자가 헷갈립니다)
  const submit = (event) => {
    event?.preventDefault();
    if (isSubmitDisabled) return;
    // 상담원/변호사의 소속은 '선택한 지부 + 입력한 부서'를 합쳐 하나의 문자열로 보관합니다.
    // (헤더 배지·관리자 계정 목록 등 기존 화면이 organization 한 필드를 그대로 쓰고 있어 호환을 유지합니다)
    const organization = requiresBranch ? buildOrganization(form.branch, form.department) : form.organization;
    onComplete({ ...form, role, organization });
  };

  return (
    <div className="screen">
      <div className="content registerContent">
        <form className="registerCard" aria-labelledby="register-title" onSubmit={submit}>
          <h1 id="register-title">회원가입</h1>
          <div className="sectionLabel">권한 선택</div>
          <div className="roleGrid">
            {roleOptions.map((item) => {
              const Icon = item.icon;
              return (
                <button className={`roleCard ${item.tone}${role === item.key ? ' selected' : ''}`} type="button" key={item.key} onClick={() => setRole(item.key)} aria-pressed={role === item.key}>
                  <Icon size={28} strokeWidth={2.2} />
                  <span><strong>{item.title}</strong><small>{item.detail}</small></span>
                </button>
              );
            })}
          </div>
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
          {emailInvalid ? <p className="formError" id="register-email-error">이메일 형식이 아닙니다. @가 포함된 이메일을 입력해주세요.</p> : null}
          <div className="formGrid">
            <label className="field"><span>비밀번호</span><input value={form.password} onChange={(e) => update('password', e.target.value)} type="password" placeholder="비밀번호 입력" /></label>
            <label className="field"><span>비밀번호 확인</span><input value={form.confirmPassword} onChange={(e) => update('confirmPassword', e.target.value)} type="password" placeholder="비밀번호 확인" /></label>
          </div>
          {passwordsMismatch ? <p className="formError">비밀번호와 비밀번호 확인이 일치하지 않습니다.</p> : null}
          {/* 관리자는 바로 쓸 수 있으니 단순 안내(파랑), 상담원·변호사는 승인까지 기다려야 하니 주의(주황)로 구분합니다. */}
          <div className={role === 'admin' ? 'notice' : 'notice warn'}>
            {role === 'admin' ? <BadgeCheck size={18} /> : <Clock size={18} />}
            <p>
              {role === 'admin'
                ? '관리자 권한은 가입 즉시 시스템에 접근할 수 있습니다.'
                : '가입 신청 후 관리자 승인이 완료되어야 로그인할 수 있습니다. 승인 결과는 가입 시 입력한 이메일로 안내됩니다.'}
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
      setMessage('모든 항목을 입력해야 회원 정보를 대조할 수 있습니다.');
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
      setMessage('입력한 정보와 일치하는 회원가입 기록이 없습니다. 이름·소속기관·부서·연락처·이메일이 가입 시 등록한 내용과 같은지 확인해주세요.');
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
          <h1 id="password-title">비밀번호 찾기</h1>
          {step === 'verify' ? (
            <form onSubmit={verify}>
              <p className="helperText">관리자가 기존 회원가입 정보와 대조할 수 있도록, 가입할 때 등록한 내용을 그대로 입력하세요.</p>
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
              <p className="helperText success">회원가입 정보가 확인되었습니다. 임시 비밀번호를 받을 수 있는 연락처를 작성해주세요.</p>
              {/* 어떤 계정으로 확인됐는지 보여줘, 동명이인이 있을 때 엉뚱한 계정으로 진행하는 것을 막습니다. */}
              <div className="verifiedAccountBox">
                <span>확인된 계정</span>
                <strong>{verifiedUser?.name} · {verifiedUser?.organization}</strong>
                <em>{verifiedUser?.email}</em>
              </div>
              <label className="field"><span>연락처</span><input value={form.contact} onChange={(e) => update('contact', e.target.value)} placeholder="휴대폰 번호 또는 이메일" /></label>
              <button className="primaryButton" type="button" disabled={!form.contact} onClick={() => setMessage('관리자 확인 후 입력한 연락처로 임시 비밀번호가 전달됩니다.')}>임시 비밀번호 요청</button>
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
