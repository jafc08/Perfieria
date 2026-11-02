FROM oven/bun:1
WORKDIR /app
COPY package.json ./
RUN bun install --production
COPY . .
ENV NODE_ENV=production FECHA_REFERENCIA=2026-09-03
EXPOSE 3000
CMD ["bun", "run", "server.ts"]
