# Kairos API — multi-stage build for Cloud Run.
# Built from the monorepo root (see .github/workflows/deploy-api.yml:
#   docker build -f apps/api/Dockerfile .)
#
# Pinned by digest, not tag (docs/14_IMPROVEMENT_REVIEW.md §2.12 / issue
# #87) — `node:20-slim` is a floating tag that can point at a different
# image tomorrow with no signal in this file; the digest is immutable, so
# a build today and a build next year use bit-identical base layers. Bump
# deliberately (re-pull + update both FROM lines) rather than silently
# drifting.
FROM node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS build
WORKDIR /repo

COPY package.json package-lock.json* ./
COPY packages/shared-contracts/package.json packages/shared-contracts/package.json
COPY apps/api/package.json apps/api/package.json
RUN npm ci

COPY tsconfig.base.json ./
COPY packages/shared-contracts packages/shared-contracts
COPY apps/api apps/api
RUN npm run build --workspace=packages/shared-contracts
RUN npm run build --workspace=apps/api

FROM node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS runtime
WORKDIR /repo
ENV NODE_ENV=production

# D4/#32, docs/23_LIVEKIT_DELIVERY.md §1: Node's own fetch/https calls
# (Gloo, YouVersion) work without this because Node bundles its own root
# CA store — but @livekit/rtc-node is a native (Rust) binary that relies
# on the SYSTEM trust store for its own TLS connections (region lookup,
# WebRTC signaling). node:20-slim doesn't install ca-certificates by
# default, so those native calls failed with a generic "error sending
# request" until this was added — found live, 2026-07-06.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
COPY packages/shared-contracts/package.json packages/shared-contracts/package.json
COPY apps/api/package.json apps/api/package.json
RUN npm ci --omit=dev

COPY --from=build /repo/packages/shared-contracts/dist packages/shared-contracts/dist
COPY --from=build /repo/apps/api/dist apps/api/dist

# fixtures/snapshots/ backs the "join link never dead" guarantee —
# DevotionalEngine.loadFixtureDevotional (apps/api/src/services/
# devotionalEngine.ts) resolves this path relative to its own compiled
# location as ../../../../fixtures/snapshots, i.e. <WORKDIR>/fixtures/
# snapshots. Without this, any generation failure in the deployed
# container throws DevotionalEngineFixtureError instead of falling back
# to fixture content (issue #68, docs/14 §1.3).
COPY fixtures/snapshots fixtures/snapshots

# assets/fonts/ carries the self-hosted Spectral/Hanken woff2 subsets the
# /stage/assets/fonts route serves (Epic T #347/#350 — session CSP is
# font-src 'self', so a CDN can never substitute). The route resolves
# ../../assets/fonts from its compiled location, i.e. apps/api/assets/
# fonts under WORKDIR. Without this COPY the route 404s and every page
# silently renders on the Georgia/system fallback stacks (live-caught
# 2026-07-23: deployed pages had fontsLoaded=false).
COPY apps/api/assets apps/api/assets

# docs/14_IMPROVEMENT_REVIEW.md §2.6 / issue #73: run as the non-root
# `node` user the base image already provides (not root, which is the
# node:20-slim default) — Cloud Run scale-down/redeploy sends SIGTERM to
# whatever's PID 1, and running as root has no upside here, only downside
# if the container is ever compromised. `LocalFileAudioStorage`'s default
# write directory (`.data/audio`, relative to WORKDIR) must be owned by
# `node` BEFORE the switch, or every write 500s with EACCES the moment
# local-file storage mode is used (chown here rather than at runtime,
# since the runtime user has no permission to chown anything itself).
RUN mkdir -p /repo/.data/audio && chown -R node:node /repo/.data
USER node

EXPOSE 8080
CMD ["node", "apps/api/dist/index.js"]
