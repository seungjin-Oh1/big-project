import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [react()],
    server: {
      // /ai-api·/stt-api 프록시는 없앴다.
      //
      // 브라우저는 이제 두 서버에 직접 닿지 않는다. 검색·추천은 core-api의 /api/ai/**로,
      // 음성 변환은 /api/stt/transcribe로 간다(AiApiProxyController, SttApiProxyController).
      // 둘 다 인증이 없는 서버라 인터넷에 열 수 없기 때문이다.
      //
      // 여기 남겨 두면 개발에서는 8001·8002가 계속 뚫려 있어서, 실수로 직접 부르는
      // 코드가 들어와도 로컬에서는 멀쩡히 돌고 배포에서만 깨진다. 그런 차이를 없애려고
      // 개발 환경도 배포와 같은 경로만 열어 둔다.
      proxy: {
        '/core-api': {
          target: env.VITE_CORE_API_PROXY_TARGET || 'http://127.0.0.1:8080',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/core-api/, ''),
        },
        '/ws': {
          target: env.VITE_WS_PROXY_TARGET || 'ws://127.0.0.1:8080',
          ws: true,
          changeOrigin: true,
        },
      },
    },
  }
})
