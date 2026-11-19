ARG DEPS_IMAGE=dependency-sources
FROM ubuntu:24.04 AS toolchain
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
COPY .github/ci/rust-toolchain /tmp/rust-toolchain
RUN sed -i 's#http://archive\.ubuntu\.com/ubuntu#http://security.ubuntu.com/ubuntu#g' \
      /etc/apt/sources.list.d/ubuntu.sources \
    && apt-get -o APT::Update::Error-Mode=any update \
    && apt-get install -y --no-install-recommends \
    build-essential ca-certificates cmake curl nasm pkg-config libssl-dev zlib1g-dev \
    && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --profile minimal --default-toolchain "$(cat /tmp/rust-toolchain)" \
    && rm -rf /var/lib/apt/lists/*
ENV PATH=/root/.cargo/bin:${PATH}
# This runtime is for functional E2E. Keep release checks and use less optimization.
ENV CARGO_PROFILE_RELEASE_OPT_LEVEL=1
ENV CARGO_PROFILE_RELEASE_STRIP=false
ENV CARGO_PROFILE_RELEASE_BUILD_OVERRIDE_STRIP=false
WORKDIR /workspace/backend-rs

FROM toolchain AS dependency-sources
COPY backend-rs/Cargo.toml backend-rs/Cargo.lock ./
COPY shared/rust /workspace/shared/rust
COPY shared/assets/calendars /workspace/shared/assets/calendars
COPY backend-rs/crates ./crates

FROM dependency-sources AS dependencies
RUN mkdir -p src examples && printf 'pub fn placeholder() {}\n' > src/lib.rs \
    && printf 'fn main() {}\n' > src/main.rs \
    && printf 'fn main() {}\n' > examples/attachment_s3_e2e.rs \
    && printf 'fn main() {}\n' > examples/attachment_hosting_e2e.rs \
    && cargo build --release --locked --bin wegent-backend-rs \
      --example attachment_s3_e2e --example attachment_hosting_e2e

FROM ${DEPS_IMAGE} AS build
COPY shared/assets/codex-models /workspace/shared/assets/codex-models
COPY backend-rs/src ./src
COPY backend-rs/examples ./examples
COPY backend-rs/migrations ./migrations
COPY shared/data/builtin-connector-apps.json ../shared/data/builtin-connector-apps.json
RUN find src examples -type f -exec touch {} + \
    && cargo build --release --locked --bin wegent-backend-rs \
      --example attachment_s3_e2e --example attachment_hosting_e2e

FROM scratch AS runtime
COPY --from=build /workspace/backend-rs/target/release/wegent-backend-rs /app/wegent-backend-rs
COPY --from=build /workspace/backend-rs/target/release/examples/attachment_s3_e2e /app/attachment-s3-e2e
COPY --from=build /workspace/backend-rs/target/release/examples/attachment_hosting_e2e /app/attachment-hosting-e2e
ENTRYPOINT ["/app/wegent-backend-rs"]
