import React, { useState } from 'react';
import { Search } from 'lucide-react';
import { useConfirm } from './feedback.jsx';
import { statusAll, today } from '../constants.jsx';
import { getDaysInMonth, getRecentYears, months, toIsoDate, weekDays } from '../utils/date.js';
import { statusChipClass } from '../utils/statusTone.js';

function StatusButton({ children, onClick, active }) {
  return <button className={active ? 'tableAction active' : 'tableAction'} type="button" onClick={onClick}>{children}</button>;
}

function SummaryCards({ cards, activeFilter, onFilter, allowToggle = true }) {
  return (
    <div className="summaryGrid">
      {cards.map((card, index) => (
        <button className={`summaryCard cardTone${index + 1}${activeFilter === card.filter ? ' active' : ''}`} type="button" key={card.title} onClick={() => onFilter(allowToggle && activeFilter === card.filter ? statusAll : card.filter)}>
          <strong>{card.title}</strong>
          <span>{card.value}</span>
        </button>
      ))}
    </div>
  );
}

// 표를 항상 같은 높이로 두기 위해 부족한 줄만큼 빈 줄을 채웁니다.
// 다만 원본 데이터가 아예 0건일 때 빈 줄만 여러 개 늘어놓으면 "화면이 비어 보이는 건지,
// 고장 난 건지" 알 수 없습니다. 그럴 때는 빈 줄 대신 안내 문구 한 줄만 보여줍니다.
function EmptyRows({ count, columns, isEmpty = false, emptyLabel = '아직 표시할 항목이 없습니다.' }) {
  if (count <= 0) return null;
  if (isEmpty) {
    return <tr><td className="tableEmptyNotice" colSpan={columns}>{emptyLabel}</td></tr>;
  }
  return Array.from({ length: count }).map((_, rowIndex) => (
    <tr key={`empty-${rowIndex}`}>{Array.from({ length: columns }).map((__, columnIndex) => <td key={columnIndex}>&nbsp;</td>)}</tr>
  ));
}

function CalendarPicker({ selectedDate, onChange }) {
  const [year, setYear] = useState(Number(selectedDate.slice(0, 4)));
  const [month, setMonth] = useState(Number(selectedDate.slice(5, 7)));
  const [openMode, setOpenMode] = useState(null);
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
    <div className="dateControls calendarControls">
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
              <button type="button" aria-label="이전 달" onClick={() => moveMonth(-1)}>←</button>
              <button type="button" aria-label="다음 달" onClick={() => moveMonth(1)}>→</button>
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
  if (diffDays <= 0) return 'TODAY';
  return `D+${diffDays}`;
}

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
      message: `${row.caseNo} · ${row.name || '상담자'}님 「${row.title || '제목 없음'}」\n삭제하면 연결된 검토 요청도 함께 사라지며 되돌릴 수 없습니다.`,
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
        {searchable ? (
          <div className="tableSearchBox">
            <Search size={14} strokeWidth={2.2} />
            <input type="text" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="이름·사건번호·제목 검색" aria-label="상담 검색" />
          </div>
        ) : null}
        {onAdd ? <button type="button" onClick={onAdd}>+ 새 상담 등록</button> : null}
        {tall ? <CalendarPicker selectedDate={selectedDate} onChange={onDateChange} /> : null}
      </div>
      <div className={scrollable ? 'tableScroll' : ''}>
        <table className={`dataTable${tall ? ' tallTable' : ''}`}>
          <thead>
            <tr>
              <th>이름</th><th>사건 번호</th><th>상태</th><th>구조대상</th>
              <th>등록일시</th>
              <th>처리 단계</th>
              {onDelete ? <th>삭제</th> : null}
            </tr>
          </thead>
          <tbody>
            {noSearchResult ? (
              <tr><td className="tableEmptyNotice" colSpan={columns}>‘{query.trim()}’에 대한 검색 결과가 없습니다.</td></tr>
            ) : null}
            {/* 모든 칸을 .cellBody로 감쌉니다.
                첫 줄은 칩(26px), 둘째 줄은 보조 설명(18px) 자리로 고정해서,
                보조 설명이 없는 칸도 같은 높이를 갖습니다.
                덕분에 칩들이 한 선에 놓이면서(첫 줄이 같은 위치) 내용 전체는 행의 세로 가운데에 옵니다. */}
            {displayRows.map((row) => (
              <tr key={row.id}>
                <td>
                  <div className="cellBody nameCell">
                    <span>{row.name}</span>
                    {/* 이름 칸이 좁아 서류명까지 넣으면 '미제출: 수급자...'처럼 잘렸습니다.
                        배지에는 잘리지 않는 짧은 문구만 두고, 어떤 서류인지는 마우스를 올리면 보이게 합니다. */}
                  </div>
                </td>
                <td>
                  <div className="cellBody">
                    <button className="caseLinkButton" type="button" onClick={() => onOpenAnalysis?.(row.id)}>
                      {row.caseNo}
                    </button>
                  </div>
                </td>
                <td>
                  <div className="cellBody">
                    <span className={statusToneClass(row.status || '진행 중')}>{row.status || '진행 중'}</span>
                  </div>
                </td>
                <td>
                  <div className="cellBody">
                    {(() => {
                      const badge = evidenceBadge(row);
                      return <span className={`evidenceBadge ${badge.tone}`} title={badge.title}>{badge.label}</span>;
                    })()}
                  </div>
                </td>
                <td>
                  {/* 연-월-일-시각을 그대로 한 줄 더 붙이면 좁은 표 칸 안에서 줄바꿈되며 레이아웃이
                      깨졌습니다. 배지만 보여주고, 정확한 등록일시는 마우스를 올렸을 때(title)
                      확인할 수 있게 둡니다. */}
                  <div className="cellBody registeredCell">
                    <span
                      className={`dayBadge${dayBadgeLabel(row.date) === 'TODAY' ? ' today' : ''}`}
                      title={row.date ? `등록일시: ${row.date}${row.registeredTime ? ` ${row.registeredTime}` : ''}` : '등록일시 미기록'}
                    >
                      {dayBadgeLabel(row.date)}
                    </span>
                  </div>
                </td>
                <td>
                  <div className="cellBody">
                    <span className={workflowStatusTone(row.workflowStatus)}>{row.workflowStatus || '분석 전'}</span>
                  </div>
                </td>
                {onDelete ? (
                  <td>
                    <div className="cellBody">
                      <button className="tableAction danger" type="button" onClick={() => handleDelete(row)}>삭제</button>
                    </div>
                  </td>
                ) : null}
              </tr>
            ))}
            {scrollable || noSearchResult ? null : <EmptyRows count={Math.max(0, visibleRowCount - displayRows.length)} columns={columns} isEmpty={rows.length === 0} emptyLabel="등록된 상담이 없습니다." />}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// '상태'(진행 중/완료/보류)든 '처리 단계'(접수→법률 검토→승인/반려)든,
// 상태 단어→색의 규칙은 statusTone 모듈 한 곳에서만 관리합니다. (색상 일관성)
const statusToneClass = statusChipClass;
const workflowStatusTone = statusChipClass;

function HitlConfirmModal({ title = 'AI 분석 결과 최종 확인', actionLabel = '작업 진행', caseInfo, onConfirm, onCancel, nested = false }) {
  // nested: 이미 열려 있는 다른 모달(예: 변호사 검토 모달) 위에 겹쳐 뜨는 경우입니다.
  // 화면 정중앙에 새로 뜨면 방금 스크롤해서 누른 '검토 확정' 버튼 위치에서 멀리 떨어져
  // 갑자기 위로 튀어 보이므로, 이때는 화면 아래쪽에 가깝게 띄워 버튼 근처에서 나타나게 합니다.
  return (
    <div className={`modalBackdrop${nested ? ' modalBackdropNested' : ''}`} role="presentation">
      <div className="modal hitlConfirmModal">
        <div className="modalHeader"><h2>{title}</h2></div>
        {caseInfo ? <p className="hitlConfirmCase">{caseInfo}</p> : null}
        <div className="hitlConfirmNotice">
          <strong>AI 분석 결과는 참고용 후보입니다.</strong>
          <span>최종 사건유형·긴급도·구조대상 확정은 상담원/변호사가 직접 검토 후 결정합니다.</span>
        </div>
        <ul className="hitlConfirmList">
          <li>AI가 제시한 분류와 근거를 그대로 확정하지 않습니다.</li>
          <li>첨부자료, 증빙서류, 법령·판례 근거를 사람이 확인합니다.</li>
          <li>이 작업은 감사 로그에 남고 이후 업무 단계에 반영됩니다.</li>
        </ul>
        <div className="inlineControls statusConfirmActions">
          <button className="smallButton light" type="button" onClick={onCancel}>취소</button>
          <button className="primaryButton hitlSubmitButton" type="button" onClick={onConfirm}>{actionLabel}</button>
        </div>
      </div>
    </div>
  );
}

export { StatusButton, SummaryCards, EmptyRows, CalendarPicker, ConsultationTable, HitlConfirmModal, workflowStatusTone };
