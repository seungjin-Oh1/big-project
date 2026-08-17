# frontend (React 19 + Vite) → nginx
#
# 빌드 결과는 정적 파일이라 Node를 운영에 둘 이유가 없다. 빌드 단계에서만 Node를
# 쓰고, 실행은 nginx가 한다. nginx는 정적 파일 서빙과 동시에 이 배포의 유일한
# 공개 지점 역할을 한다(deploy/nginx.conf 참고).

FROM node:22-slim AS build
WORKDIR /build

# 의존성을 먼저 설치한다. 소스만 바뀌었을 때 이 레이어를 재사용하기 위해서다.
# npm ci는 package-lock.json을 그대로 따르므로 빌드가 재현된다(npm install은
# lock을 갱신할 수 있어 이미지마다 다른 버전이 들어갈 수 있다).
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# 프론트는 API 주소를 하드코딩하지 않는다. 같은 도메인의 /core-api/** 로 부르고
# nginx가 뒤로 넘긴다(coreApiClientV2.js CORE_API_BASE_URL = '/core-api').
# 그래서 도메인 때문에 넣어야 할 환경변수는 없다 — 같은 이미지를 어느 도메인에도
# 그대로 올릴 수 있다.
#
# 예외가 셋 있다: 시연용 빠른 로그인 버튼의 비밀번호다. 배포에서는 서버가
# application.yaml의 기본값(test1234)을 쓸 수 없다 — DevSecretGuard가 기본 시크릿이
# 남아 있으면 기동을 거부하므로 비밀번호가 반드시 달라지고, 그러면 버튼만 조용히
# 깨진다. 안 주면 기본값으로 빌드되므로 로컬은 지금까지와 똑같이 동작한다.
ARG VITE_MASTER_TALKER_PASSWORD
ARG VITE_MASTER_LAWYER_PASSWORD
ARG VITE_MASTER_ADMIN_PASSWORD
ENV VITE_MASTER_TALKER_PASSWORD=$VITE_MASTER_TALKER_PASSWORD \
    VITE_MASTER_LAWYER_PASSWORD=$VITE_MASTER_LAWYER_PASSWORD \
    VITE_MASTER_ADMIN_PASSWORD=$VITE_MASTER_ADMIN_PASSWORD

RUN npm run build

# ── 실행 ────────────────────────────────────────────────────────────────────
FROM nginx:1.27-alpine

# 기본 설정을 지운다. 남겨 두면 default.conf가 먼저 잡혀 프록시 설정이 통째로 무시된다.
#
# 우리 설정(deploy/nginx.conf)은 이미지에 굽지 않고 compose에서 마운트한다.
# 빌드 컨텍스트가 frontend/라 레포 루트의 deploy/에 COPY로 닿을 수 없기도 하고,
# 프록시 경로나 타임아웃을 고칠 때마다 프론트를 다시 빌드하는 건 낭비다.
RUN rm -f /etc/nginx/conf.d/default.conf

COPY --from=build /build/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
    CMD wget -q -O /dev/null http://localhost/ || exit 1
