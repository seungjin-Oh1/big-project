import React from 'react';
import { Bell, BookOpen, ClipboardCheck, FileText, LayoutDashboard, Search, UserRound } from 'lucide-react';

function Brand({ onClick }) {
  const content = (
    <>
      <img className="brandMark" src="/brand-mark.png" alt="대한법률구조공단 심볼" />
      <div>
        <strong>대한법률구조공단</strong>
        <span>법률구조 상담 지원 포털</span>
      </div>
    </>
  );

  if (onClick) {
    return (
      <button className="brand brandButton" type="button" onClick={onClick} aria-label="대시보드로 이동">
        {content}
      </button>
    );
  }

  return <div className="brand">{content}</div>;
}

function Header({ onLogin, onRegister, onHome, hideLogin }) {
  return (
    <header className="topbar">
      <Brand onClick={onHome} />
      <nav className="headerActions" aria-label="페이지 이동">
        {hideLogin ? null : <button className="smallButton light" type="button" onClick={onLogin}>로그인</button>}
        <button className="smallButton dark" type="button" onClick={onRegister}>회원가입</button>
      </nav>
    </header>
  );
}

// 아직 연결할 문서가 없는 항목은 링크(a href="#")로 두지 않습니다.
// 눌러도 페이지 맨 위로만 튀어 "고장 난 링크"처럼 느껴지므로, 준비 중임을 밝힌 일반 텍스트로 보여줍니다.
const footerPolicies = ['개인정보 처리방침', '이용 약관', '저작권 정책', '오픈소스 라이선스'];

function Footer() {
  return (
    <footer className="footer">
      <strong>인공지능 법률업무 지원 시스템</strong>
      <div className="footerLinks">
        {footerPolicies.map((label) => (
          <span key={label} title="문서 준비 중입니다.">{label}</span>
        ))}
      </div>
      <p>© 대한법률구조공단. 모든 권리 보유. 버전 1.0.0</p>
    </footer>
  );
}

// 상단 배지 문구를 두 줄로 나눕니다.
//
// 한 줄로 "이름 역할 · 지부 부서"를 늘어놓으면 무엇이 중요한지 드러나지 않고 가로로도 길어집니다.
// 이 배지의 용도는 "지금 누구로, 어떤 권한으로 로그인했는지" 확인하는 것이므로
//   윗줄 = 이름 + 역할 (확인에 필요한 핵심, 크게)
//   아랫줄 = 지부 + 부서 (맥락 정보, 작게 / 공문서 관례대로 넓은 단위 → 좁은 단위 순)
// 로 나눠 표시합니다.
//
// 관리자는 본부 소속이라 지부·부서가 따로 없고 organization 한 줄만 있습니다.
function formatIdentityBadge(currentUser, roleLabel) {
  if (!currentUser?.name) return { primary: roleLabel, secondary: '' };

  const primary = `${currentUser.name} ${roleLabel}`;
  if (currentUser.branch) {
    // 부서 없이 가입한 예전 계정도 있으므로, 부서가 있을 때만 이어 붙입니다.
    const department = currentUser.department
      || (currentUser.organization || '').split(' / ').slice(1).join(' / ');
    return { primary, secondary: department ? `${currentUser.branch} ${department}` : currentUser.branch };
  }
  return { primary, secondary: currentUser.organization || '' };
}

function DashboardHeader({ role, activeView, onViewChange, onLogout, currentUser, unreadCount = 0 }) {
  const active = role === 'counselor' ? '상담원' : role === 'lawyer' ? '변호사' : '관리자';
  // 플로우차트/요구사항 정의서에 정리된 업무 범위에 맞춰 역할별로 메뉴 자체를 다르게 구성합니다.
  // - 상담원: 상담 접수(상담 등록) → 상담 분석(기타) → 법률·판례 참고 → 서식 초안 생성까지 전체 흐름 담당
  // - 변호사/공익법무관: 상담 접수는 관여하지 않고, 대시보드의 검토 요청 목록에서 검토·승인만 담당
  // - 관리자: 상담 접수/분석/서식 생성에는 관여하지 않고, 운영 관리(계정 승인·통계·감사로그)만 담당
  const navConfig = {
    counselor: [
      { view: '알림', label: '알림' },
      { view: '대시보드', label: '상담 현황' },
      { view: '상담 등록', label: '상담 문서 업로드' },
      { view: '기타', label: '실시간 분석 AI' },
      { view: '법률, 판례', label: '법률, 판례' },
      { view: '서식 생성', label: '서식 생성' },
      { view: '프로필', label: '프로필' },
    ],
    lawyer: [
      { view: '알림', label: '알림' },
      { view: '대시보드', label: '검토' },
      { view: '법률, 판례', label: '법률, 판례' },
      { view: '프로필', label: '프로필' },
    ],
    admin: [
      { view: '알림', label: '알림' },
      { view: '대시보드', label: '운영 현황' },
      { view: '기타', label: '운영 관리' },
      { view: '프로필', label: '프로필' },
    ],
  };
  const navItems = navConfig[role] || navConfig.counselor;
  const navIcon = ({ view, label }) => {
    if (role === 'lawyer' && view === '대시보드') return ClipboardCheck;
    if (view === '대시보드') return LayoutDashboard;
    if (label === '상담 등록' || label === '상담 문서 업로드') return FileText;
    if (label === '상담 분석' || label === '실시간 분석 AI' || label === '검토' || label === '운영 관리') return ClipboardCheck;
    if (label === '법률, 판례') return Search;
    if (view === '서식 생성') return BookOpen;
    if (label === '알림') return Bell;
    return UserRound;
  };
  return (
    <header className="dashboardHeader">
      <Brand onClick={() => onViewChange('대시보드')} />
      <nav className="dashboardNav" aria-label="업무 메뉴">
        {navItems.map((item) => {
          const Icon = navIcon(item);
          const isNotification = item.view === '알림';
          return (
            <button
              className={activeView === item.view ? 'navText active' : 'navText'}
              type="button"
              key={item.view}
              // 현재 화면을 색만으로 알리면 화면낭독기 사용자는 알 수 없어 aria-current를 함께 둡니다.
              aria-current={activeView === item.view ? 'page' : undefined}
              onClick={() => onViewChange(item.view)}
            >
              <Icon size={14} strokeWidth={2.2} />
              <span>{item.label}</span>
              {isNotification && unreadCount ? <em aria-label={`읽지 않은 알림 ${unreadCount}건`}>{unreadCount}</em> : null}
            </button>
          );
        })}
        {(() => {
          const identity = formatIdentityBadge(currentUser, active);
          return (
            <span className="navPill">
              <strong>{identity.primary}</strong>
              {identity.secondary ? <small>{identity.secondary}</small> : null}
            </span>
          );
        })()}
        <button className="smallButton dark" type="button" onClick={onLogout}>로그아웃</button>
      </nav>
    </header>
  );
}

// Brand는 이 파일 내부(Header/DashboardHeader)에서만 쓰이는 구현 세부사항이라
// 더 이상 export하지 않습니다(외부에서 import하는 곳이 없었습니다).
export { Header, Footer, DashboardHeader };
