# Многоступенчатая сборка api, worker и web.
# ADR-002: production-артефакты собираются явно, а не запускаются из исходников
# через runtime type stripping.
FROM node:24.14.0-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps ./apps
COPY packages ./packages
COPY tools ./tools
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY tsconfig.base.json turbo.json ./
RUN pnpm build

# Отдельный слой с зависимостями без dev: в runtime-образ не попадают
# ни toolchain, ни тестовые зависимости.
FROM build AS pruned
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=pruned /app /app
# Процессы не выполняются от root.
USER node

FROM runtime AS api
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "apps/api/dist/main.js"]

FROM runtime AS worker
CMD ["node", "apps/worker/dist/main.js"]

# I03: экран наблюдателя.
#
# Отдельная стадия, а не общий `runtime`, по двум причинам. Первая: Next.js запускается своим
# сервером (`next start`) из каталога приложения, а не одним файлом. Вторая, важнее: `pruned`
# выбрасывает dev-зависимости, а `next` нужен и в рантайме, поэтому web берёт слой `build`.
#
# Адрес API НЕ фиксируется на сборке: он приходит переменной окружения и читается на сервере при
# запросе (`page.tsx` — `force-dynamic`). Next подставляет значения из `env` конфига в клиентский
# бандл во время build, и первая редакция экрана именно так и сломалась: собранный образ навсегда
# запомнил бы адрес машины, на которой его собрали.
FROM build AS web
ENV NODE_ENV=production
WORKDIR /app/apps/web
USER node
EXPOSE 3100
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3100/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["pnpm", "exec", "next", "start", "--port", "3100"]
