# Многоступенчатая сборка api и worker.
# Образы приложений собираются только по явной необходимости (`docker compose --profile app`);
# для тестов и разработки достаточно сервиса postgres.
FROM node:24.14.0-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
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

FROM build AS api
ENV NODE_ENV=production
EXPOSE 3001
CMD ["node", "apps/api/src/main.ts"]

FROM build AS worker
ENV NODE_ENV=production
CMD ["node", "apps/worker/src/main.ts"]
