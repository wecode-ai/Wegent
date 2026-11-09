ARG DEPS_IMAGE=dependencies
FROM ubuntu:24.04 AS toolchain
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
COPY .github/ci/rust-toolchain /tmp/rust-toolchain
RUN sed -i 's#http://archive\.ubuntu\.com/ubuntu#http://security.ubuntu.com/ubuntu#g' \
      /etc/apt/sources.list.d/ubuntu.sources \
    && apt-get -o APT::Update::Error-Mode=any update \
    && apt-get install -y --no-install-recommends \
    build-essential ca-certificates cmake curl nasm pkg-config libssl-dev libsasl2-dev libcurl4-openssl-dev zlib1g-dev \
    && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --profile minimal --default-toolchain "$(cat /tmp/rust-toolchain)" \
    && rm -rf /var/lib/apt/lists/*
ENV PATH=/root/.cargo/bin:${PATH}
ENV CARGO_PROFILE_RELEASE_STRIP=false
ENV CARGO_PROFILE_RELEASE_BUILD_OVERRIDE_STRIP=false
WORKDIR /workspace/backend-rs

FROM toolchain AS dependencies
COPY backend-rs/Cargo.toml backend-rs/Cargo.lock ./
COPY shared/rust /workspace/shared/rust
COPY backend-rs/crates ./crates
RUN mkdir -p src && printf 'pub fn placeholder() {}\n' > src/lib.rs \
    && printf 'fn main() {}\n' > src/main.rs \
    && cargo build --release --locked --bin wegent-backend-rs

FROM ${DEPS_IMAGE} AS build
COPY backend-rs/src ./src
COPY backend-rs/examples ./examples
COPY backend-rs/migrations ./migrations
RUN find src examples -type f -exec touch {} + \
    && cargo build --release --locked --bin wegent-backend-rs \
      --example attachment_s3_e2e --example attachment_hosting_e2e

FROM scratch AS runtime
COPY --from=build /workspace/backend-rs/target/release/wegent-backend-rs /app/wegent-backend-rs
COPY --from=build /workspace/backend-rs/target/release/examples/attachment_s3_e2e /app/attachment-s3-e2e
COPY --from=build /workspace/backend-rs/target/release/examples/attachment_hosting_e2e /app/attachment-hosting-e2e
ENTRYPOINT ["/app/wegent-backend-rs"]
