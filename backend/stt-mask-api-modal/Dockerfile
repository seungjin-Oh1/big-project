# stt-mask-api-modal — 실시간 음성 담당 (대면 마이크 + 전화)
#
# 이름과 달리 이 컨테이너는 GPU를 쓰지 않는다. 전사는 Modal에 올라간 Qwen3-ASR이
# 하고(MODAL_ASR_WS_URL), 여기는 오디오를 그쪽으로 중계하고 결과를 가려서
# 돌려주는 역할이다. 그래서 CPU 인스턴스에 그냥 얹으면 된다.
#
#   WS   /ws/transcribe/external   core-api가 대면 녹음을 흘려보내는 곳
#   POST /webhook                  Twilio가 통화 시작을 알리는 곳 (TwiML 응답)
#   WS   /webhook                  Twilio 통화 오디오 스트림
FROM python:3.12-slim
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .

# torch를 CPU 전용 휠로 먼저 깐다.
#
# 이 컨테이너는 GPU를 쓰지 않는다. 전사는 Modal의 A10G가 하고 여기는 오디오를
# 그쪽으로 중계할 뿐이며, 개인정보 가림 모델은 main.py가 device_map="cpu"로 올린다.
# 그런데 기본 torch는 CUDA 빌드라 cuDNN·cuBLAS·NCCL이 딸려와 이미지가 13.3GB가 됐다.
#
# GPU를 쓰는 modal/modal_asr.py는 .dockerignore로 빼놨다 — 그건 Modal에 올리는
# 코드지 이 컨테이너가 실행하는 코드가 아니다.
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu

# accelerate가 requirements.txt에 빠져 있다. main.py의 pipeline(device_map="cpu")이
# 이걸 요구해서, 없으면 import 시점에 ValueError로 죽는다. 작성자 환경에는 이미
# 깔려 있어서 드러나지 않았다. requirements.txt에 반영되면 이 줄은 지워도 된다.
RUN pip install --no-cache-dir -r requirements.txt accelerate

COPY . .

# main.py가 app.mount("/static", StaticFiles(directory="static"))로 이 폴더를 연다.
# 없으면 import 시점에 RuntimeError로 죽으므로, 커밋에서 빠져 있어도 뜨게 만든다.
RUN mkdir -p static

# 가림 모델을 미리 받아둔다. 첫 통화가 다운로드를 기다리게 두지 않는다.
RUN python -c "from transformers import pipeline; pipeline('token-classification', model='openai/privacy-filter', aggregation_strategy='simple', device_map='cpu')"

RUN useradd --system --create-home --shell /usr/sbin/nologin app \
    && chown -R app:app /app
USER app

EXPOSE 9000

HEALTHCHECK --interval=15s --timeout=5s --start-period=120s --retries=5 \
    CMD curl -fsS http://localhost:9000/docs > /dev/null || exit 1

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "9000"]
