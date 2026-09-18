# Read Deeper — Cloud Run image.
# Uses the FULL production node_modules (identical dependency tree to local),
# NOT the standalone-traced subset: pdf-parse/pdfjs (+ @napi-rs/canvas native
# binding, which provides DOMMatrix) get mangled by file tracing.
# glibc base (slim, not alpine) for reliable native bindings.

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-slim AS run
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV HOSTNAME=0.0.0.0
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY next.config.mjs ./
COPY .env.production ./
EXPOSE 8080
CMD ["node", "node_modules/next/dist/bin/next", "start", "-p", "8080"]
