import React from 'react';
import { Trash2, Bell, BellOff } from 'lucide-react';
import { useConfirm } from '../../../components/feedback.jsx';
import { WorkPageHeader, InlineEmptyNotice } from '../../../components/common.jsx';
import { formatDateTimeLabel } from '../../../utils/date.js';

export function NotificationPanel({ role, currentUser, notifications = [], onReadNotifications, onDeleteNotification, onOpenNotification }) {
  const confirm = useConfirm();
  const notificationKey = `${role}:${currentUser?.email || 'all'}`;
  const roleNotifications = notifications.filter((item) => {
    if (!item.roles?.includes(role)) return false;
    if (item.recipientEmail && item.recipientEmail !== currentUser?.email) return false;
    return !item.deletedBy?.includes(role) && !item.deletedBy?.includes(notificationKey);
  });
  const unreadCount = roleNotifications.filter((item) => !item.readBy?.includes(role) && !item.readBy?.includes(notificationKey)).length;
  const handleDelete = async (event, item, unread) => {
    event.stopPropagation();
    if (unread) {
      const accepted = await confirm({
        title: '읽지 않은 알림을 삭제할까요?',
        message: `「${item.title}」\n읽지 않은 알림이 삭제됩니다.`,
        confirmLabel: '삭제',
        tone: 'danger',
      });
      if (!accepted) return;
    }
    onDeleteNotification?.(item.id, role, currentUser?.email);
  };
  return (
    <section className="workPanel notificationPanel">
      <WorkPageHeader
        title="알림"
        description="새 알림을 확인하고 해당 업무로 바로 이동하세요."
        meta={(
          <span className="notificationHeaderMeta">
            <span className="notificationCount">새 알림 {unreadCount}건</span>
            {/* 알림이 쌓일수록 이 버튼을 찾아 목록 맨 아래까지 내려야 했던 문제를 없애기 위해
                목록 위(헤더 옆)로 옮겼습니다. */}
            <button className="ghostActionButton compactAction" type="button" onClick={() => onReadNotifications?.(role, currentUser?.email)} disabled={!unreadCount}><BellOff size={13} strokeWidth={2.4} aria-hidden="true" /> 전체 읽음 처리</button>
          </span>
        )}
      />
      <div className="utilityContentCard notificationContentCard">
        {roleNotifications.length ? (
          <div className="notificationList">
            {roleNotifications.map((item) => {
              const unread = !item.readBy?.includes(role) && !item.readBy?.includes(notificationKey);
              const reviewFeedback = item.detail?.type === 'reviewFeedback';
              // 예전엔 이 <article> 전체가 role="button"이면서 그 안에 진짜 <button>(삭제)이
              // 또 있어, 스크린리더가 "버튼 안에 버튼"을 읽는 잘못된 구조였습니다. 마우스로는
              // 여전히 행 어디를 눌러도 열리도록 onClick만 남기고(역할 없는 일반 클릭이라
              // 문제 없음), 키보드·스크린리더 사용자를 위한 진짜 버튼을 "바로 처리/내용 보기"
              // 자리에 따로 둡니다 — 삭제 버튼과 나란한 형제 버튼이라 중첩되지 않습니다.
              return (
                <article
                  className={unread ? 'notificationItem unread' : 'notificationItem read'}
                  key={item.id}
                  onClick={() => onOpenNotification?.(item)}
                >
                  <div className="notificationItemTop">
                    <strong className="notificationItemTitle">
                      <i className="notificationDot" aria-hidden="true" />
                      {unread ? <Bell size={13} strokeWidth={2.4} aria-hidden="true" /> : <BellOff size={13} strokeWidth={2.2} aria-hidden="true" />}
                      {item.title}
                    </strong>
                    <span className="notificationItemTime">{formatDateTimeLabel(item.createdAt)}</span>
                  </div>
                  {reviewFeedback ? (
                    <div className="notificationReviewFeedback is-compact" aria-label="변호사 검토 피드백">
                      <div className="notificationReviewFeedbackHead">
                        <strong>{item.target || '검토 사건'}</strong>
                        <span>{item.detail.status || '검토 완료'}</span>
                      </div>
                      <dl>
                        {item.detail.reason ? <div><dt>사유</dt><dd>{item.detail.reason}</dd></div> : null}
                        {item.detail.comment ? <div><dt>코멘트</dt><dd>{item.detail.comment}</dd></div> : null}
                        {item.detail.editedSummary ? <div><dt>수정 안내</dt><dd>{item.detail.editedSummary}</dd></div> : null}
                      </dl>
                    </div>
                  ) : <p className="notificationItemMessage">{item.message}</p>}
                  <div className="notificationActions">
                    <button
                      type="button"
                      className="notificationState"
                      onClick={(event) => { event.stopPropagation(); onOpenNotification?.(item); }}
                    >
                      {unread ? '바로 처리 ›' : '내용 보기'}
                    </button>
                    <button className="notificationDelete" type="button" onClick={(event) => handleDelete(event, item, unread)}><Trash2 size={12} strokeWidth={2.4} aria-hidden="true" /> 삭제</button>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="notificationEmptyState" role="status">
            <InlineEmptyNotice>새 알림이 없습니다.</InlineEmptyNotice>
            <p>새로운 업무 알림이 도착하면 이곳에서 확인할 수 있습니다.</p>
          </div>
        )}
      </div>
    </section>
  );
}
