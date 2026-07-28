import React, { createContext, useContext, useEffect, useState } from 'react';

// 사이트 전역에서 공통으로 쓸 "1초 이상 걸리면 로딩 표시" 규칙의 기준 시간입니다.
const DEFAULT_LOADING_DELAY_MS = 1000;
const DEFAULT_LOADING_MESSAGE = '처리 중입니다. 잠시만 기다려주세요.';

// 로딩 표시 정책: 작업이 일정 시간(delayMs) 이상 걸릴 때만 오버레이를 보여줘서,
// 즉시 끝나는 작업에서 불필요하게 화면이 깜빡이는 것을 막습니다.
function useDelayedLoading(isLoading, delayMs) {
  const [shouldShowOverlay, setShouldShowOverlay] = useState(false);

  useEffect(() => {
    if (!isLoading) {
      setShouldShowOverlay(false);
      return undefined;
    }
    const timerId = setTimeout(() => setShouldShowOverlay(true), delayMs);
    return () => clearTimeout(timerId);
  }, [isLoading, delayMs]);

  return shouldShowOverlay;
}

// 순수 시각 요소: Uiverse의 바운스 도트 애니메이션 마크업만 담당합니다.
// (원본 CSS의 nth-child 규칙이 적용되도록 circle 3개 -> shadow 3개 순서를 그대로 유지해야 합니다.)
function BounceDotsAnimation() {
  return (
    <div className="bounceLoader" aria-hidden="true">
      <div className="bounceCircle" />
      <div className="bounceCircle" />
      <div className="bounceCircle" />
      <div className="bounceShadow" />
      <div className="bounceShadow" />
      <div className="bounceShadow" />
    </div>
  );
}

// 화면 전반에서 공통으로 쓰는 로딩 오버레이입니다.
// isLoading이 delayMs(기본 1초) 넘게 유지될 때만 화면 전체를 덮어 "진행 중" 상태를 알려줍니다.
function LoadingOverlay({ isLoading, delayMs = DEFAULT_LOADING_DELAY_MS, message = DEFAULT_LOADING_MESSAGE }) {
  const showOverlay = useDelayedLoading(isLoading, delayMs);
  if (!showOverlay) return null;

  return (
    <div className="loadingOverlay" role="status" aria-live="polite">
      <BounceDotsAnimation />
      <p className="loadingOverlayMessage">{message}</p>
    </div>
  );
}

// 버튼 하나하나마다 로딩 상태와 오버레이를 직접 연결하지 않아도 되도록,
// 앱 전체에서 공유하는 로딩 신호와 오버레이를 한 곳(Provider)에서 관리합니다.
const LoadingActionContext = createContext(null);

function LoadingProvider({ children }) {
  // 여러 버튼이 동시에 비동기 작업을 실행할 수 있으므로 boolean이 아닌 진행 중 개수로 관리합니다.
  const [pendingCount, setPendingCount] = useState(0);
  const [message, setMessage] = useState(DEFAULT_LOADING_MESSAGE);

  const runWithLoading = async (task, taskMessage = DEFAULT_LOADING_MESSAGE) => {
    setMessage(taskMessage);
    setPendingCount((count) => count + 1);
    try {
      return await task();
    } finally {
      setPendingCount((count) => count - 1);
    }
  };

  return (
    <LoadingActionContext.Provider value={runWithLoading}>
      {children}
      <LoadingOverlay isLoading={pendingCount > 0} message={message} />
    </LoadingActionContext.Provider>
  );
}

// 버튼 클릭 핸들러에서 "async () => {...}"를 이 훅이 반환하는 함수로 감싸기만 하면,
// 그 작업이 1초 넘게 걸릴 때 자동으로 전역 로딩 오버레이가 뜹니다.
function useAsyncAction() {
  const runWithLoading = useContext(LoadingActionContext);
  if (!runWithLoading) {
    throw new Error('useAsyncAction은 <LoadingProvider> 내부에서만 사용할 수 있습니다.');
  }
  return runWithLoading;
}

// LoadingOverlay/useDelayedLoading은 이 파일 내부(LoadingProvider)에서만 쓰이는 구현 세부사항이라
// 더 이상 export하지 않습니다(외부에서 import하는 곳이 없었습니다).
export { LoadingProvider, useAsyncAction };
