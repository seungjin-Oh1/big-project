1. VoIP 서버가 로컬 fastapi 서버에 요청이 가능해야 하므로 Ngrok 같은 로컬 프록시를 설정해둡니다.
2. Clawops 서비스에 가입을 해서 전화번호 발급 후, 전화번호 Webhook 에 위에 로컬 프록시 <URL + /webhook> 을 입력해 줍니다.
3. Streaming STT 모델을 사용하기 위해 gpu가 필요하므로 Modal 이라는 원격 서비스르 통해 서버를 올려줍니다. Modal 가입 후 설정해준 뒤 modal serve ./modal/modal_asr.py 실행 (비용 발생)
4. 로컬 fastapi 서버를 띄워줍니다 uvicorn main:app --host 0.0.0.0 --port 9000