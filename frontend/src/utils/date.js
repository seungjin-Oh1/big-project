import { today } from '../constants.jsx';

export const months = Array.from({ length: 12 }, (_, index) => `${index + 1}월`);
export const weekDays = ['일', '월', '화', '수', '목', '금', '토'];

export function toIsoDate(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function getRecentYears() {
  const currentYear = new Date(today).getFullYear();
  return Array.from({ length: 6 }, (_, index) => currentYear - index);
}

export function getDaysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

// 알림 목록처럼 '언제 왔는지'를 한 줄로 보여주는 자리의 표기를 한 곳에 모읍니다.
// toLocaleString('ko-KR')은 "2026. 7. 29. 오후 2:22"처럼 길이가 들쭉날쭉해 표가 흔들립니다.
export function formatDateTimeLabel(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// 통화 시간을 "3:07"처럼 분:초로 보여줍니다. 실시간 상담 화면의 통화 타이머와, 상단 헤더의
// '통화 중' 표시가 같은 형식을 써야 해서 한 곳에 모아 공유합니다.
export function formatCallDuration(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
