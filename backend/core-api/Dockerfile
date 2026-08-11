# core-api (Spring Boot 4, Java 17)
#
# 2단계로 나눈다: 빌드에는 JDK와 Gradle이 필요하지만 실행에는 JRE만 있으면 된다.
# 한 단계로 만들면 이미지에 소스와 Gradle 캐시가 그대로 남아 수백 MB가 커지고,
# 운영 컨테이너에 컴파일러가 들어가는 것도 좋지 않다.

# ── 빌드 ────────────────────────────────────────────────────────────────────
FROM eclipse-temurin:17-jdk AS build
WORKDIR /build

# 의존성 정의를 먼저 복사해 받아둔다. 소스만 바뀌었을 때 이 레이어가 재사용되어
# 빌드가 훨씬 빨라진다 — 소스와 함께 복사하면 매번 전부 다시 받는다.
COPY gradle/ gradle/
COPY gradlew settings.gradle build.gradle ./
RUN chmod +x gradlew && ./gradlew dependencies --no-daemon || true

COPY src/ src/
# 테스트는 CI에서 돌린다. 이미지 빌드에서까지 돌리면 DB가 없어 실패하고,
# 있어도 배포마다 수 분이 더 걸린다.
RUN ./gradlew bootJar --no-daemon -x test

# ── 실행 ────────────────────────────────────────────────────────────────────
FROM eclipse-temurin:17-jre
WORKDIR /app

# HEALTHCHECK용. JRE 이미지에는 curl이 없어서 넣지 않으면 검사가 항상 실패하고,
# compose의 depends_on 조건이 영원히 충족되지 않는다.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

# root로 돌리지 않는다. 컨테이너가 뚫렸을 때 할 수 있는 일을 줄인다.
RUN useradd --system --create-home --shell /usr/sbin/nologin app
COPY --from=build --chown=app:app /build/build/libs/*.jar app.jar
USER app

EXPOSE 8080

# 컨테이너 메모리에 맞춰 힙을 잡는다. 고정 -Xmx를 쓰면 인스턴스를 바꿀 때마다
# 손대야 하고, 안 주면 JVM이 호스트 전체 메모리를 기준으로 잡아 OOM으로 죽는다.
ENV JAVA_OPTS="-XX:MaxRAMPercentage=70 -XX:+UseContainerSupport"

# 컨테이너가 살아 있는 것과 앱이 응답하는 것은 다르다. compose가 이걸 보고
# 기동 순서를 잡는다.
#
# actuator가 없어서 인증 없이 열려 있는 경로 중 부작용 없는 것을 쓴다.
# /api/auth/captcha는 쓰면 안 된다 — 부를 때마다 캡차를 발급해 메모리에 쌓는다.
# captcha-required는 실패 횟수 맵을 읽기만 한다.
HEALTHCHECK --interval=15s --timeout=5s --start-period=120s --retries=5 \
    CMD curl -fsS "http://localhost:8080/api/auth/captcha-required?email=healthcheck@local" > /dev/null || exit 1

ENTRYPOINT ["sh", "-c", "exec java $JAVA_OPTS -jar app.jar"]
