import { useEffect, useRef, useState } from 'react';
import {
  Bell,
  BookMarked,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  Clock,
  FileText,
  Inbox,
  Info,
  LayoutGrid,
  MessageSquareText,
  MinusCircle,
  PauseCircle,
  Radio,
  RefreshCw,
  Scale,
  Search,
  Settings,
  ShieldCheck,
  Trash2,
  TrendingUp,
  UserRound,
  Users,
  XCircle,
} from 'lucide-react';
import { useConfirm } from './feedback.jsx';
import { useDismissOnOutsideOrEscape } from '../hooks/useDismissOnOutsideOrEscape.js';
import { statusAll, today } from '../constants.jsx';
import { getDaysInMonth, getRecentYears, months, toIsoDate, weekDays } from '../utils/date.js';
import { statusChipClass } from '../utils/statusTone.js';

// 목록 표는 첫 7개 열(이름 포함)까지만 화면에 바로 보이고, 그 다음 열부터는 가로로
// 드래그하거나 스크롤해야 보이도록 합니다(표에 열이 늘어나도 항상 같은 규칙 하나로 처리).
// 트랙패드/스크롤바로도 당연히 넘길 수 있어야 하므로 overflow-x:auto는 그대로 두고,
// 여기서는 '마우스로 표를 붙잡고 좌우로 끄는' 동작만 추가로 얹습니다.
function useHorizontalDragScroll() {
  const containerRef = useRef(null);
  const dragRef = useRef({ dragging: false, startX: 0, startScrollLeft: 0 });

  const beginDrag = (event) => {
    const container = containerRef.current;
    if (!container) return;
    dragRef.current = { dragging: true, startX: event.pageX, startScrollLeft: container.scrollLeft };
    container.classList.add('dragging');
  };
  const continueDrag = (event) => {
    const container = containerRef.current;
    if (!dragRef.current.dragging || !container) return;
    event.preventDefault();
    container.scrollLeft = dragRef.current.startScrollLeft - (event.pageX - dragRef.current.startX);
  };
  const endDrag = () => {
    dragRef.current.dragging = false;
    containerRef.current?.classList.remove('dragging');
  };

  return { containerRef, beginDrag, continueDrag, endDrag };
}

// 표 하나를 가로 스크롤 컨테이너로 감싸는 공용 래퍼입니다. ConsultationTable뿐 아니라
// 관리자 화면의 일자별 상담 내역 표처럼 '7열까지만 바로 보이고 이후는 가로 스크롤'이
// 필요한 다른 목록 표에서도 그대로 재사용합니다.
function HorizontalScrollBox({ children, className = '' }) {
  const { containerRef, beginDrag, continueDrag, endDrag } = useHorizontalDragScroll();
  return (
    <div
      className={className ? `tableScrollX ${className}` : 'tableScrollX'}
      ref={containerRef}
      onMouseDown={beginDrag}
      onMouseMove={continueDrag}
      onMouseUp={endDrag}
      onMouseLeave={endDrag}
    >
      {children}
    </div>
  );
}

// 표 안 7개 칸(이름 포함)이 항상 스크롤 없이 보이도록 칸마다 최소 너비를 못 박아 둡니다.
// 칸이 8개 이상으로 늘어나면 표 전체 너비가 컨테이너보다 커져 HorizontalScrollBox가
// 자동으로 가로 스크롤을 만들어 냅니다(테이블 레이아웃을 auto로 두어 칸 수가 늘어난 만큼
// 표 너비도 함께 늘어나게 합니다 — fixed였다면 칸이 늘어도 기존 칸들만 좁아질 뿐입니다).
// 마지막 값(삭제 칸)은 삭제 알약 버튼이 칸 테두리에 거의 붙어 답답해 보인다는 피드백을 받아
// 90 → 112로 늘려, 버튼 좌우로 여유를 더 줍니다.
const FIRST_SEVEN_COLUMN_MIN_WIDTHS = [100, 120, 90, 100, 96, 110, 112];

function ScrollableDataTable({ className = '', children }) {
  return (
    <table className={className ? `dataTable ${className}` : 'dataTable'} style={{ tableLayout: 'auto', width: 'max-content', minWidth: '100%' }}>
      {children}
    </table>
  );
}

// 업무 화면 제목(title) 문구에서 화면 성격을 나타내는 아이콘을 골라 줍니다.
// workflowIntro 헤더들이 화면마다 맥락에 맞는 아이콘을 앞세우는 것과 같은 언어를
// WorkPageHeader(더 상위 페이지 제목)에도 이어가되, 새로운 prop을 추가하지 않고
// 이미 넘어오는 title 문자열만으로 판정합니다(앞의 규칙이 먼저 매칭).
function workPageHeaderIcon(title) {
  if (!title) return null;
  if (title.includes('서식')) return FileText;
  if (title.includes('법령') || title.includes('판례')) return Scale;
  if (title.includes('담은 자료')) return BookMarked;
  if (title.includes('알림')) return Bell;
  // 메뉴의 '내 정보'(프로필) 항목이 이미 UserRound를 쓰므로 페이지 제목도 맞춥니다.
  if (title.includes('내 정보')) return UserRound;
  if (title.includes('운영')) return Settings;
  // '실시간 상담'은 전화로 진행하는 통화 상담이므로, 통화 목록·업무 흐름 단계에서 이미 쓰는
  // Radio 아이콘(신호/통화 느낌)으로 맞춥니다 — 일반 채팅 말풍선(MessageSquareText)보다 더 맞는 은유입니다.
  if (title.includes('실시간')) return Radio;
  if (title.includes('상담')) return MessageSquareText;
  return null;
}

// 모든 업무 화면의 제목 영역은 '큰 제목 → 한 줄 설명' 두 단으로 통일합니다.
// 화면마다 h2/p를 따로 쓰면 글자 크기·간격이 조금씩 달라지므로 이 컴포넌트 하나로 모읍니다.
// meta는 제목 오른쪽에 붙는 보조 표시(예: '새 알림 2건')입니다.
function WorkPageHeader({ title, description, meta }) {
  const TitleIcon = workPageHeaderIcon(title);
  return (
    <header className="workPageHeader">
      <div className="workPageHeaderText">
        <h2>{TitleIcon ? <TitleIcon size={22} strokeWidth={2.2} className="workPageHeaderIcon" aria-hidden="true" /> : null}{title}</h2>
        {description ? <p className="workPageDescription">{description}</p> : null}
      </div>
      {meta ? <div className="workPageHeaderMeta">{meta}</div> : null}
    </header>
  );
}

function StatusButton({ children, onClick, active }) {
  return <button className={active ? 'tableAction active' : 'tableAction'} type="button" onClick={onClick}>{children}</button>;
}

// 카드 제목(title) 문구에서 KPI 성격을 읽어 알맞은 아이콘을 골라 줍니다. 상담원/변호사/관리자
// 대시보드마다 카드 문구가 서로 다르지만(예: '총 상담' vs '전체 검토 요청' vs '전체 상담 건수')
// '전체·대기·완료·보류·진행 중'처럼 상태를 나타내는 낱말은 공통적으로 등장하므로, 그 낱말
// 기준으로 하나의 규칙만 둡니다(statusTone과 같은 접근). 앞의 규칙이 먼저 매칭됩니다.
function summaryCardIcon(title) {
  if (!title) return null;
  if (title.includes('사용자')) return Users;
  if (title.includes('대기')) return Clock;
  if (title.includes('완료') || title.includes('승인')) return CheckCircle2;
  if (title.includes('보류')) return PauseCircle;
  if (title.includes('처리율') || title.includes('율')) return TrendingUp;
  if (title.includes('중')) return RefreshCw;
  if (title.includes('전체') || title.includes('총')) return LayoutGrid;
  return null;
}

function SummaryCards({ cards, activeFilter, onFilter, allowToggle = true }) {
  return (
    <div className="summaryGrid">
      {cards.map((card, index) => {
        const CardIcon = summaryCardIcon(card.title);
        return (
          <button className={`summaryCard cardTone${index + 1}${activeFilter === card.filter ? ' active' : ''}`} type="button" key={card.title} onClick={() => onFilter(allowToggle && activeFilter === card.filter ? statusAll : card.filter)}>
            <strong className={CardIcon ? 'hasIcon' : ''}>
              {CardIcon ? <CardIcon size={14} strokeWidth={2.4} className="summaryCardIcon" aria-hidden="true" /> : null}
              {card.title}
            </strong>
            <span>{card.value}</span>
          </button>
        );
      })}
    </div>
  );
}

// 표를 항상 같은 높이로 두기 위해 부족한 줄만큼 빈 줄을 채웁니다.
// 다만 원본 데이터가 아예 0건일 때 빈 줄만 여러 개 늘어놓으면 "화면이 비어 보이는 건지,
// 고장 난 건지" 알 수 없습니다. 그럴 때는 빈 줄 대신 안내 문구 한 줄만 보여줍니다.
//
// 빈 칸도 실제 데이터 칸과 똑같이 .cellBody(첫 줄 26px + 둘째 줄 18px)로 감싸야 합니다.
// 그냥 <td>&nbsp;</td>만 두면 실제 데이터 행보다 짧아져서, 같은 6줄이어도 실제 데이터가
// 몇 건 있느냐에 따라 표 전체 높이가 달라집니다(나란히 둔 다른 표와 아래쪽이 어긋납니다).
function EmptyRows({ count, columns, isEmpty = false, emptyLabel = '표시할 항목 없음' }) {
  if (count <= 0) return null;
  if (isEmpty) {
    // 표마다 "없습니다" 텍스트 한 줄만 있으면 화면이 빈 건지 고장 난 건지 헷갈리므로,
    // 모든 표가 같은 아이콘+문구 패턴을 쓰게 공용 컴포넌트(EmptyRows) 한 곳에서 통일합니다.
    return (
      <tr>
        <td className="tableEmptyNotice" colSpan={columns}>
          <Inbox size={18} strokeWidth={1.8} aria-hidden="true" />
          <span>{emptyLabel}</span>
        </td>
      </tr>
    );
  }
  // 실제 데이터가 1건이라도 있으면(= isEmpty 아님) 표 높이만 맞추는 자리 채우기 줄입니다.
  // 예전엔 이 줄에도 다른 행과 똑같은 테두리선이 그려져서, 실제 데이터 1~2건 아래로
  // 빈 칸에 격자선만 남아 "표가 덜 그려졌나?" 싶은 느낌을 줬습니다(직접 화면으로 확인).
  // emptyFillerRow 클래스로 테두리를 지워, 그 아래는 그냥 빈 여백으로 보이게 합니다.
  return Array.from({ length: count }).map((_, rowIndex) => (
    <tr key={`empty-${rowIndex}`} className="emptyFillerRow" aria-hidden="true">
      {Array.from({ length: columns }).map((__, columnIndex) => (
        <td key={columnIndex}><div className="cellBody"><span>&nbsp;</span><span>&nbsp;</span></div></td>
      ))}
    </tr>
  ));
}

// 표 밖(패널·리스트 등)에서 쓰는 짧은 빈 상태 한 줄입니다. EmptyRows(표 안)와 같은
// 아이콘+문구 패턴을 표 밖에서도 그대로 재사용해 "정보 없음"류 문구가 화면마다
// 제각각으로 보이지 않게 합니다.
function InlineEmptyNotice({ children, action }) {
  if (!children) return null;
  return (
    <p className="templateEmpty">
      <Inbox size={16} strokeWidth={1.8} aria-hidden="true" />
      <span>{children}</span>
      {action || null}
    </p>
  );
}

function CalendarPicker({ selectedDate, onChange }) {
  const containerRef = useRef(null);
  const [year, setYear] = useState(Number(selectedDate.slice(0, 4)));
  const [month, setMonth] = useState(Number(selectedDate.slice(5, 7)));
  const [openMode, setOpenMode] = useState(null);
  useDismissOnOutsideOrEscape(containerRef, Boolean(openMode), () => setOpenMode(null));
  const selectedDay = Number(selectedDate.slice(8, 10));
  const availableYears = getRecentYears();
  const minYear = Math.min(...availableYears);
  const maxYear = Math.max(...availableYears);
  const firstDay = new Date(year, month - 1, 1).getDay();
  const days = getDaysInMonth(year, month);
  const previousMonth = month === 1 ? 12 : month - 1;
  const previousYear = month === 1 ? year - 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const previousDays = getDaysInMonth(previousYear, previousMonth);
  const cells = Array.from({ length: 42 }, (_, index) => {
    const dayNumber = index - firstDay + 1;
    if (dayNumber < 1) return { day: previousDays + dayNumber, month: previousMonth, year: previousYear, muted: true };
    if (dayNumber > days) return { day: dayNumber - days, month: nextMonth, year: nextYear, muted: true };
    return { day: dayNumber, month, year, muted: false };
  });

  const changeYearMonth = (nextYear, nextMonth) => {
    if (nextYear < minYear || nextYear > maxYear) return;
    const safeDay = Math.min(selectedDay, getDaysInMonth(nextYear, nextMonth));
    setYear(nextYear);
    setMonth(nextMonth);
    onChange(toIsoDate(nextYear, nextMonth, safeDay));
  };

  const selectYear = (nextYear) => {
    changeYearMonth(nextYear, month);
    setOpenMode(null);
  };

  const selectMonth = (nextMonth) => {
    changeYearMonth(year, nextMonth);
    setOpenMode(null);
  };

  const moveMonth = (direction) => {
    const next = new Date(year, month - 1 + direction, 1);
    changeYearMonth(next.getFullYear(), next.getMonth() + 1);
  };

  const chooseDay = (cell) => {
    if (cell.year < minYear || cell.year > maxYear) return;
    setYear(cell.year);
    setMonth(cell.month);
    onChange(toIsoDate(cell.year, cell.month, cell.day));
    setOpenMode(null);
  };

  return (
    <div className="dateControls calendarControls" ref={containerRef}>
      <div className="calendarPickerUnit">
        <button className={`calendarButton${openMode === 'year' ? ' active' : ''}`} type="button" onClick={() => setOpenMode((mode) => mode === 'year' ? null : 'year')}>{year}년</button>
        {openMode === 'year' ? (
          <div className="calendarPopup calendarPopup-year">
              <div className="calendarPopupTitle">연도 선택</div>
              <div className="calendarOptionGrid yearOptionGrid">
                {availableYears.map((item) => (
                  <button className={item === year ? 'selectedOption' : ''} type="button" key={item} onClick={() => selectYear(item)}>{item}년</button>
                ))}
              </div>
          </div>
        ) : null}
      </div>
      <div className="calendarPickerUnit">
        <button className={`calendarButton${openMode === 'month' ? ' active' : ''}`} type="button" onClick={() => setOpenMode((mode) => mode === 'month' ? null : 'month')}>{month}월</button>
        {openMode === 'month' ? (
          <div className="calendarPopup calendarPopup-month">
              <div className="calendarPopupTitle">{year}년 월 선택</div>
              <div className="calendarOptionGrid monthOptionGrid">
                {months.map((label, index) => (
                  <button className={index + 1 === month ? 'selectedOption' : ''} type="button" key={label} onClick={() => selectMonth(index + 1)}>{label}</button>
                ))}
              </div>
          </div>
        ) : null}
      </div>
      <div className="calendarPickerUnit">
        <button className={`calendarButton${openMode === 'day' ? ' active' : ''}`} type="button" onClick={() => setOpenMode((mode) => mode === 'day' ? null : 'day')}>{selectedDay}일</button>
        {openMode === 'day' ? (
          <div className="calendarPopup calendarPopup-day">
          <div className="calendarPopupHeader">
            <strong>{year}년 {String(month).padStart(2, '0')}월</strong>
            <div>
              <button type="button" aria-label="이전 달" onClick={() => moveMonth(-1)}><ChevronLeft size={16} strokeWidth={2.4} aria-hidden="true" /></button>
              <button type="button" aria-label="다음 달" onClick={() => moveMonth(1)}><ChevronRight size={16} strokeWidth={2.4} aria-hidden="true" /></button>
            </div>
          </div>
          <div className="calendarWeek">{weekDays.map((day) => <span key={day}>{day}</span>)}</div>
          <div className="calendarGrid">
            {cells.map((cell, index) => (
              <button
                className={`${cell.muted ? 'mutedDay' : ''}${cell.day === selectedDay && cell.month === month && cell.year === year ? ' selectedDay' : ''}`}
                type="button"
                key={`${cell.year}-${cell.month}-${cell.day}-${index}`}
                disabled={cell.year < minYear || cell.year > maxYear}
                onClick={() => chooseDay(cell)}
              >
                {cell.day}
              </button>
            ))}
          </div>
          <div className="calendarFooter calendarFooterSingle">
            <button type="button" onClick={() => {
              const date = new Date(today);
              setYear(date.getFullYear());
              setMonth(date.getMonth() + 1);
              onChange(today);
              setOpenMode(null);
            }}>오늘</button>
          </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function dayBadgeLabel(dateStr) {
  if (!dateStr) return '';
  const diffDays = Math.round((new Date(today) - new Date(dateStr)) / 86400000);
  if (diffDays <= 0) return '오늘';
  // 공적 기관 사이트라 'D+1' 같은 캐주얼한 게임/커머스식 표기 대신, 다른 표(요청 경과)와
  // 같은 '1일 경과' 문구로 통일합니다.
  return `${diffDays}일 경과`;
}

// evidenceBadge의 톤(neutral/pending/submitted/missing)마다 statusChip과 같은 언어로 아이콘을
// 붙입니다. 같은 표 안에서 statusChip은 아이콘이 있는데 이 배지만 없으면 줄마다 들쭉날쭉해 보이므로
// (statusToneIcon과 같은 접근) 톤 하나에 아이콘 하나씩만 고정합니다.
const EVIDENCE_TONE_ICONS = {
  pending: Clock,
  neutral: MinusCircle,
  submitted: CheckCircle2,
  missing: XCircle,
};

function evidenceBadge(row) {
  const check = row.eligibilityCheck;
  // '대상 아님'/'구조대상'만 보고는 어떤 대상 유형 기준으로 판정했는지 알 수 없어서,
  // 상담 등록 때 고른 법률구조 대상 유형(applicantType)을 title 툴팁에 항상 함께 담습니다.
  const applicantType = check?.applicantType || '대상 유형 미확인';
  if (!check) return { label: '확인 필요', tone: 'pending', title: '법률구조 대상 여부가 아직 확인되지 않았습니다.' };
  if (!check.isTargetCandidate) return { label: '대상 아님', tone: 'neutral', title: `대상 유형: ${applicantType} (법률구조 대상 유형에 해당하지 않습니다)` };
  if (check.evidenceSubmitted) return { label: '구조대상', tone: 'submitted', title: `대상 유형: ${applicantType} · 증빙 제출 확인: ${check.requiredEvidence}` };
  return { label: '증빙 필요', tone: 'missing', title: `대상 유형: ${applicantType} · 증빙 미제출: ${check.requiredEvidence}` };
}

function ConsultationTable({ title, rows, onAdd, onDelete, onOpenAnalysis, tall = false, selectedDate, onDateChange, searchable = false }) {
  const baseColumns = 6;
  const columns = baseColumns + (onDelete ? 1 : 0);
  const [query, setQuery] = useState('');
  const confirm = useConfirm();
  const handleDelete = async (row) => {
    if (!onDelete) return;
    const accepted = await confirm({
      title: '이 상담을 삭제할까요?',
      // 무엇이 지워지는지 사건번호까지 보여줘서 다른 건을 잘못 지우는 일을 막습니다.
      message: `${row.caseNo} · ${row.name || '상담자'} · 「${row.title || '제목 없음'}」\n연결된 검토 요청도 함께 삭제됩니다.`,
      confirmLabel: '삭제',
      tone: 'danger',
    });
    if (accepted) onDelete(row.id);
  };
  // 이름·사건번호·상담 제목 기준으로 로컬 검색합니다. (서버 검색 API 연결 전까지 프론트에서 필터)
  const normalizedQuery = searchable ? query.trim().toLowerCase() : '';
  const displayRows = normalizedQuery
    ? rows.filter((row) => [row.name, row.caseNo, row.title].some((value) => (value || '').toLowerCase().includes(normalizedQuery)))
    : rows;
  const visibleRowCount = 6;
  // '일정별 상담 목록'(tall)도 '최근 상담 목록'과 똑같이 6칸을 유지하고, 그보다 많으면
  // 칸을 늘리지 않고 스크롤로 다음 항목을 보게 합니다. (예전엔 tall일 때만 제외해서
  // 하루에 상담이 6건을 넘으면 화면이 그만큼 길게 늘어났습니다)
  const scrollable = displayRows.length > visibleRowCount;
  const noSearchResult = Boolean(normalizedQuery) && displayRows.length === 0;
  return (
    <section className={tall ? 'calendarPanel' : 'panel'}>
      <div className="panelTitleRow">
        <h2>{title}</h2>
        <span className="panelCountBadge">{rows.length}건</span>
        {onDelete ? (
          <p className="tableInteractionGuide" role="note">
            <Info size={13} strokeWidth={2.2} aria-hidden="true" />
            상태·단계는 현황 표시이며 삭제만 조작할 수 있습니다.
          </p>
        ) : null}
        {searchable ? (
          <div className="tableSearchBox">
            <Search size={14} strokeWidth={2.2} />
            <input type="text" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="이름·사건번호·제목 검색" aria-label="상담 검색" />
          </div>
        ) : null}
        {onAdd ? <button type="button" onClick={onAdd}>+ 새 상담 등록</button> : null}
        {tall ? <CalendarPicker selectedDate={selectedDate} onChange={onDateChange} /> : null}
      </div>
      <HorizontalScrollBox>
        <div className={scrollable ? 'tableScroll' : ''}>
          <ScrollableDataTable className={tall ? 'tallTable' : ''}>
          <thead>
            <tr>
              <th style={{ minWidth: FIRST_SEVEN_COLUMN_MIN_WIDTHS[0] }}>이름</th>
              <th style={{ minWidth: FIRST_SEVEN_COLUMN_MIN_WIDTHS[1] }}>사건 번호</th>
              <th style={{ minWidth: FIRST_SEVEN_COLUMN_MIN_WIDTHS[2] }}>상태</th>
              <th style={{ minWidth: FIRST_SEVEN_COLUMN_MIN_WIDTHS[3] }}>구조대상</th>
              <th style={{ minWidth: FIRST_SEVEN_COLUMN_MIN_WIDTHS[4] }}>등록일시</th>
              <th style={{ minWidth: FIRST_SEVEN_COLUMN_MIN_WIDTHS[5] }}>처리 단계</th>
              {onDelete ? <th style={{ minWidth: FIRST_SEVEN_COLUMN_MIN_WIDTHS[6] }}>삭제</th> : null}
            </tr>
          </thead>
          <tbody>
            {noSearchResult ? (
              <tr><td className="tableEmptyNotice" colSpan={columns}>검색 결과 없음</td></tr>
            ) : null}
            {/* 모든 칸을 .cellBody로 감쌉니다.
                첫 줄은 칩(26px), 둘째 줄은 보조 설명(18px) 자리로 고정해서,
                보조 설명이 없는 칸도 같은 높이를 갖습니다.
                덕분에 칩들이 한 선에 놓이면서(첫 줄이 같은 위치) 내용 전체는 행의 세로 가운데에 옵니다. */}
            {displayRows.map((row) => (
              <tr key={row.id}>
                <td>
                  <div className="cellBody nameCell">
                    <span>{row.name || '이름 미입력'}</span>
                    {/* 이름 칸이 좁아 서류명까지 넣으면 '미제출: 수급자...'처럼 잘렸습니다.
                        배지에는 잘리지 않는 짧은 문구만 두고, 어떤 서류인지는 마우스를 올리면 보이게 합니다. */}
                  </div>
                </td>
                <td>
                    <div className="cellBody">
                    <button className="caseLinkButton" type="button" onClick={() => onOpenAnalysis?.(row.id)} aria-label={`${row.caseNo} 상담 분석 열기`}>
                      {row.caseNo}
                    </button>
                  </div>
                </td>
                <td>
                  <div className="cellBody">
                    {(() => {
                      const StatusIcon = statusToneIcon(row.status || '진행 중');
                      return <span className={statusToneClass(row.status || '진행 중')}><StatusIcon size={12} strokeWidth={2.4} aria-hidden="true" />{row.status || '진행 중'}</span>;
                    })()}
                  </div>
                </td>
                <td>
                  <div className="cellBody">
                    {(() => {
                      const badge = evidenceBadge(row);
                      const EvidenceIcon = EVIDENCE_TONE_ICONS[badge.tone] || Info;
                      return (
                        <span className={`evidenceBadge ${badge.tone}`} title={badge.title}>
                          <EvidenceIcon size={12} strokeWidth={2.4} aria-hidden="true" />
                          {badge.label}
                        </span>
                      );
                    })()}
                  </div>
                </td>
                <td>
                  {/* 연-월-일-시각을 그대로 한 줄 더 붙이면 좁은 표 칸 안에서 줄바꿈되며 레이아웃이
                      깨졌습니다. 배지만 보여주고, 정확한 등록일시는 마우스를 올렸을 때(title)
                      확인할 수 있게 둡니다. */}
                  <div className="cellBody registeredCell">
                    <span
                      className={`dayBadge${dayBadgeLabel(row.date) === '오늘' ? ' today' : ''}`}
                      title={row.date ? `등록일시: ${row.date}${row.registeredTime ? ` ${row.registeredTime}` : ''}` : '등록일시 미기록'}
                    >
                      {dayBadgeLabel(row.date)}
                    </span>
                  </div>
                </td>
                <td>
                  <div className="cellBody">
                    {(() => {
                      const StatusIcon = statusToneIcon(row.workflowStatus);
                      return <span className={workflowStatusTone(row.workflowStatus)}><StatusIcon size={12} strokeWidth={2.4} aria-hidden="true" />{row.workflowStatus || '분석 전'}</span>;
                    })()}
                  </div>
                </td>
                {onDelete ? (
                  <td>
                    <div className="cellBody">
                      <button className="tableAction danger" type="button" onClick={() => handleDelete(row)} aria-label={`${row.caseNo} 상담 삭제`}><Trash2 size={12} strokeWidth={2.4} />삭제</button>
                    </div>
                  </td>
                ) : null}
              </tr>
            ))}
            {scrollable || noSearchResult ? null : <EmptyRows count={Math.max(0, visibleRowCount - displayRows.length)} columns={columns} isEmpty={rows.length === 0} emptyLabel="등록된 상담이 없습니다." />}
          </tbody>
          </ScrollableDataTable>
        </div>
      </HorizontalScrollBox>
    </section>
  );
}

// '상태'(진행 중/완료/보류)든 '처리 단계'(접수→법률 검토→승인/반려)든,
// 상태 단어→색의 규칙은 statusTone 모듈 한 곳에서만 관리합니다. (색상 일관성)
const statusToneClass = statusChipClass;
const workflowStatusTone = statusChipClass;

// ReviewTable(dashboards.jsx)의 '톤 이름 → 아이콘' 매핑과 같은 언어를 상담 표에도 이어갑니다.
// 실제 색·판정 기준은 여전히 statusChipClass(단일 기준)를 그대로 따르고, 여기서는 그 톤 이름에
// 아이콘만 매핑합니다(상태 칩과 처리 단계 칩 모두 같은 톤 체계를 쓰므로 함께 재사용합니다).
const STATUS_TONE_ICONS = {
  success: CheckCircle2,
  danger: XCircle,
  warn: PauseCircle,
  info: RefreshCw,
  muted: Info,
};
function statusToneIcon(status) {
  const tone = statusChipClass(status).replace('statusChip tone-', '');
  return STATUS_TONE_ICONS[tone] || Info;
}

function HitlConfirmModal({ title = 'AI 분석 결과 최종 확인', actionLabel = '작업 진행', caseInfo, onConfirm, onCancel, nested = false }) {
  const confirmButtonRef = useRef(null);
  // feedback.jsx의 ConfirmDialog와 같은 이유입니다: 창이 뜨면 기본 버튼에 포커스를 옮기고,
  // Esc로 취소할 수 있게 합니다. 이 모달은 되돌릴 수 없는 작업(검토 결과 확정 등)의
  // 마지막 확인창이라 키보드/스크린리더로도 정확히 닫고 확정할 수 있어야 합니다.
  useEffect(() => {
    confirmButtonRef.current?.focus();
  }, []);
  useEffect(() => {
    const onKeyDown = (event) => { if (event.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);
  // nested: 이미 열려 있는 다른 모달(예: 변호사 검토 모달) 위에 겹쳐 뜨는 경우입니다.
  // 화면 정중앙에 새로 뜨면 방금 스크롤해서 누른 '검토 확정' 버튼 위치에서 멀리 떨어져
  // 갑자기 위로 튀어 보이므로, 이때는 화면 아래쪽에 가깝게 띄워 버튼 근처에서 나타나게 합니다.
  return (
    <div className={`modalBackdrop${nested ? ' modalBackdropNested' : ''}`} role="presentation" onClick={onCancel}>
      <div
        className="modal hitlConfirmModal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="hitl-confirm-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modalHeader"><h2 id="hitl-confirm-title"><ShieldCheck size={18} strokeWidth={2.2} className="sectionIcon" aria-hidden="true" /> {title}</h2></div>
        {caseInfo ? <p className="hitlConfirmCase">{caseInfo}</p> : null}
        <div className="hitlConfirmNotice">
          <strong>AI 결과는 참고용입니다.</strong>
          <span>최종 판단은 담당자가 확정합니다.</span>
        </div>
        <ul className="hitlConfirmList">
          <li>분류·근거 확인</li>
          <li>첨부자료·증빙 확인</li>
          <li>감사 로그 반영</li>
        </ul>
        <div className="inlineControls statusConfirmActions">
          <button className="smallButton light" type="button" onClick={onCancel}>취소</button>
          <button className="primaryButton hitlSubmitButton" type="button" ref={confirmButtonRef} onClick={onConfirm}>{actionLabel}</button>
        </div>
      </div>
    </div>
  );
}

// 정보가 많은 화면(실시간 상담 분석 결과, 변호사 확정 전 확인)에서 모든 섹션을 한 번에
// 펼쳐두면 스크롤이 길어지고 정작 지금 필요한 내용을 찾기 어렵다는 사용자 피드백에 따라
// 만든 공용 접이식 섹션입니다. defaultOpen이 false인 섹션은 접힌 채로 시작하고, 제목 줄만
// 눌러도 펼쳐집니다 — 내용 자체는 그대로 두고 "한 번에 보이는 양"만 줄이는 목적이라
// 섹션 안 로직(입력값·상태)은 전혀 건드리지 않습니다.
// className을 넘기면 기존 hitlSection처럼 이미 스타일이 정해진 감싸개 클래스를 그대로
// 이어받아(예: 왼쪽 번호 레일) 새 시각 언어를 추가로 만들지 않습니다.
// confirmed/onToggleConfirm을 넘기면 제목 줄에 "확인" 체크가 함께 뜹니다. 상담원·변호사가
// 이 섹션 내용을 확인했다는 걸 스스로 표시해두는 용도입니다. 처음엔 "확인" 버튼을 직접
// 눌러야 했는데, 어차피 섹션을 펼쳐서 내용을 봤다면 그게 곧 확인이라는 피드백에 따라
// 펼쳐지는(= 내용을 읽는) 시점에 자동으로 확인 처리합니다. 배지는 그대로 두어 상태를
// 보여주고, 눌러서 되돌리는 것도 여전히 가능합니다. 접기/펼치기와는 별개 동작이라
// 헤더를 버튼 하나로 두지 않고 토글 버튼 + 확인 배지 두 개를 나란히 둡니다(버튼 안에
// 버튼을 넣는 잘못된 마크업을 피하기 위함).
// pinned: 코치 피드백("가장 유용하다고 보이는 부분은 아코디언을 하지 않는 게 어떨까요?
// 부수적인 내용은 뒤로 미루거나 짧게")을 받아, 화면에서 가장 중요한 섹션은 아예 접고 펴는
// 동작 자체를 없애 항상 펼쳐진 상태로 고정합니다(제목이 버튼이 아니라 그냥 텍스트가 되고,
// 화살표도 없어집니다). 나머지 부수적인 섹션은 기존처럼 접었다 펼 수 있는 아코디언으로 두어,
// "중요한 건 바로 보이고 부수적인 건 눌러야 보인다"는 위계를 명확히 합니다.
// open을 넘기면 바깥에서 이 섹션의 펼침 상태를 직접 정합니다("확인하고 다음으로" 버튼이
// 다른 섹션을 대신 펼쳐야 하는 HITL 검토 화면처럼). 안 넘기면 예전처럼 이 컴포넌트가 스스로
// 펼침 상태를 들고 있어, 기존에 이 컴포넌트를 쓰던 화면들은 전혀 바뀌지 않습니다.
function CollapsibleSection({ icon: Icon, title, defaultOpen = false, badge, className = '', id, open: controlledOpen, onToggle, confirmed, onToggleConfirm, pinned = false, children }) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen || pinned);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;
  const isOpen = pinned || open;
  useEffect(() => {
    if (isOpen && onToggleConfirm && !confirmed) onToggleConfirm(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);
  const wrapperClass = ['collapsibleSection', className, isOpen ? 'is-open' : '', pinned ? 'is-pinned' : ''].filter(Boolean).join(' ');
  const toggle = () => {
    const next = !open;
    if (!isControlled) setInternalOpen(next);
    onToggle?.(next);
  };
  // 확인 배지 클릭은 펼치기/접기와 다른 동작이라, 이 배지를 눌렀을 때는 바깥 헤더의 토글이
  // 같이 실행되지 않도록 막습니다(정보 확인 ≠ 섹션 접기).
  const stopAndToggleConfirm = (event) => {
    event.stopPropagation();
    onToggleConfirm(!confirmed);
  };
  const confirmBadge = onToggleConfirm && !pinned ? (
    <span
      role="button"
      tabIndex={0}
      className={`collapsibleSectionConfirm${confirmed ? ' is-confirmed' : ''}`}
      aria-pressed={confirmed}
      aria-label={confirmed ? '확인함' : '확인'}
      title={confirmed ? '확인함' : '확인'}
      onClick={stopAndToggleConfirm}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          stopAndToggleConfirm(event);
        }
      }}
    >
      {confirmed ? <CheckCircle2 size={16} strokeWidth={2.2} aria-hidden="true" /> : <Circle size={14} strokeWidth={2.4} aria-hidden="true" />}
    </span>
  ) : null;
  return (
    <div className={wrapperClass} id={id}>
      {pinned ? (
        <div className="collapsibleSectionHeader">
          <h3 className="collapsibleSectionStaticTitle">{Icon ? <Icon size={16} strokeWidth={2.2} className="sectionIcon" aria-hidden="true" /> : null}{title}</h3>
          <span className="collapsibleSectionMeta">{badge}</span>
        </div>
      ) : (
        // 예전엔 제목 글자 위(.collapsibleSectionToggle)만 눌러야 펼쳐지고, 오른쪽 배지·화살표
        // 자리를 누르면 아무 반응이 없었습니다. "화살표를 눌렀는데 왜 안 펼쳐지지" 피드백을 받아,
        // 확인 배지를 뺀 헤더 줄 전체를 하나의 버튼으로 묶어 어디를 눌러도 펼쳐지게 합니다.
        <button type="button" className="collapsibleSectionHeader collapsibleSectionToggle" onClick={toggle} aria-expanded={open}>
          <h3>{Icon ? <Icon size={16} strokeWidth={2.2} className="sectionIcon" aria-hidden="true" /> : null}{title}</h3>
          <span className="collapsibleSectionMeta">
            {badge}
            {confirmBadge}
            <ChevronDown size={16} strokeWidth={2.2} className="collapsibleSectionChevron" aria-hidden="true" />
          </span>
        </button>
      )}
      <div className="collapsibleSectionBody">
        <div className="collapsibleSectionBodyInner">{children}</div>
      </div>
    </div>
  );
}

// 서버/네트워크 오류가 나면 axios/fetch가 영어 원문 예외(예: "I/O error on POST request
// for ...")를 그대로 error.message에 담아 올려보낼 때가 있습니다. 이런 문장을 토스트에
// 그대로 띄우면 상담원·변호사가 무엇을 해야 할지 알 수 없으므로(코치 피드백: 개발자
// 용어를 유저 친화적으로), 사람이 읽을 한글 메시지가 아니면 안내문으로 바꿔치기합니다.
// 반대로 우리 코드가 직접 던진 한글 메시지(예: '서버에 저장된 HWPX 초안만...')는 실제로
// 다음 행동을 알려주는 유용한 정보라 그대로 보여줍니다.
function isReadableErrorMessage(message) {
  return Boolean(message) && /[가-힣]/.test(message);
}

function friendlyErrorMessage(error, fallback) {
  const message = error?.message || '';
  return isReadableErrorMessage(message) ? message : fallback;
}

export { StatusButton, SummaryCards, EmptyRows, InlineEmptyNotice, CalendarPicker, ConsultationTable, HitlConfirmModal, WorkPageHeader, workflowStatusTone, HorizontalScrollBox, ScrollableDataTable, FIRST_SEVEN_COLUMN_MIN_WIDTHS, CollapsibleSection, friendlyErrorMessage };
