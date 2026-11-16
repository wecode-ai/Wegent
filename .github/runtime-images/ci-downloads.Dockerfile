FROM golang:1.25.9 AS minio
ENV CGO_ENABLED=0 GOBIN=/output
RUN go install github.com/minio/minio@9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a

FROM node:24.14.1-bookworm AS downloads
WORKDIR /seed
COPY wework/electron/package.json /tmp/electron-package.json
RUN version="$(node -p 'require("/tmp/electron-package.json").devDependencies.electron')" \
    && npm install --prefix /seed --ignore-scripts --no-package-lock "electron@$version" tar@7.5.22
COPY wework/codex-binaries.lock.json ./wework/codex-binaries.lock.json
COPY LICENSES/Apache-2.0.txt ./LICENSES/Apache-2.0.txt
COPY wework/third_party/codex ./wework/third_party/codex
COPY wework/scripts/prepare-codex-binary.mjs ./wework/scripts/prepare-codex-binary.mjs
COPY wework/scripts/lib/process-lock.mjs wework/scripts/lib/electron-zip-cache.mjs ./wework/scripts/lib/
ENV WEGENT_CODEX_CACHE_DIR=/seed/cache/codex
RUN node wework/scripts/prepare-codex-binary.mjs --target x86_64-unknown-linux-gnu \
    && cp -a wework/resources/binaries/codex/legal /seed/cache/codex/legal
RUN node --input-type=module -e \
    'import {prepareSharedElectronZip} from "./wework/scripts/lib/electron-zip-cache.mjs"; await prepareSharedElectronZip({electronPackageRoot:"/seed/node_modules/electron",environment:{WEWORK_ELECTRON_ZIP_DIR:"/seed/cache/electron-zips"},runtime:{platform:"linux",arch:"x64"}})'
COPY --from=minio /output/minio /seed/cache/minio/minio
RUN /seed/cache/minio/minio --version \
    && tar -czf /downloads.tar.gz -C /seed/cache codex electron-zips minio

FROM scratch
COPY --from=downloads /downloads.tar.gz /downloads.tar.gz
