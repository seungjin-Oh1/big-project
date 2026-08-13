# ai-api (FastAPI, Python 3.12)
#
# 3.12로 고정한다 — 3.13/3.14에서는 일부 의존성이 설치되지 않는다(CLAUDE.md).
FROM python:3.12-slim
WORKDIR /app

# ffmpeg: whisper가 mp3/m4a/webm을 열 때 외부 실행파일로 부른다. pip으로 안 들어온다.
# curl: HEALTHCHECK용.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg curl \
    && rm -rf /var/lib/apt/lists/*

# 의존성을 먼저 설치한다. 앱 소스만 바뀌었을 때 이 레이어를 재사용해야 한다 —
# torch·sentence-transformers까지 매번 다시 받으면 빌드가 10분씩 걸린다.
COPY requirements.txt .

# torch를 CPU 전용 휠로 먼저 깐다.
#
# 그냥 `pip install torch`를 하면 기본이 CUDA 빌드라 cuDNN·cuBLAS·NCCL·triton 같은
# 것이 개당 수백 MB씩 딸려온다. 실측으로 이미지가 10.1GB가 됐다.
#
# 여기서 GPU를 쓸 일이 없다 — EC2(t3.xlarge)에 GPU가 없고, whisper와 임베딩은 CPU로
# 돈다. 실시간 전사는 Modal의 A10G가 하지만 그건 Modal 쪽 이미지다.
#
# requirements.txt를 뒤에 설치하면 torch가 이미 충족된 것으로 보고 건너뛴다.
RUN pip install --no-cache-dir torch==2.13.0 --index-url https://download.pytorch.org/whl/cpu
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# ── 자산(Chroma 색인 177MB, 서식 23MB)은 이미지에 굽지 않는다 ────────────────
#
# git에 없는 파일이라 빌드 컨텍스트에 있으리라는 보장이 없고, 넣으면 이미지가
# 200MB 커지며 색인을 다시 만들 때마다 이미지를 새로 빌드해야 한다.
#
# 대신 컨테이너가 뜰 때 S3에서 내려받는다(scripts/deploy_assets.py pull).
# 받은 것은 볼륨에 남으므로 두 번째 기동부터는 체크섬만 비교하고 넘어간다.
# 이 스크립트는 AWS 자격증명과 S3_BUCKET_NAME이 있어야 동작한다.
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

RUN useradd --system --create-home --shell /usr/sbin/nologin app \
    && chown -R app:app /app
USER app

EXPOSE 8001

HEALTHCHECK --interval=15s --timeout=5s --start-period=180s --retries=5 \
    CMD curl -fsS http://localhost:8001/docs > /dev/null || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8001"]
