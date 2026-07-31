import { Headphones, Scale, UserRound } from 'lucide-react';

function getLocalToday() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export const today = getLocalToday();
export const statusAll = '전체';

export const initialConsultations = [];
export const initialReviews = [];

export const roleOptions = [
  {
    key: 'counselor',
    icon: Headphones,
    title: '상담원',
    detail: '실시간 상담 시작',
    tone: 'orange',
  },
  {
    key: 'lawyer',
    icon: Scale,
    title: '변호사',
    detail: '사건·서류 검토 시작',
    tone: 'blue',
  },
  {
    key: 'admin',
    icon: UserRound,
    title: '관리자',
    detail: '운영 관리 시작',
    tone: 'green',
  },
];
