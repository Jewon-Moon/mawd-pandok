# 의존성이 없어 설치 단계가 없습니다. Node 22.18+는 TypeScript를 그대로 실행합니다.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8000
COPY package.json ./
COPY src ./src
COPY public ./public
USER node
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:8000/health || exit 1
CMD ["node", "src/server.ts"]
