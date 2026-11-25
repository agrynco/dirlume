FROM ubuntu:22.04

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && curl -fsSL https://packages.microsoft.com/config/ubuntu/22.04/packages-microsoft-prod.deb -o /tmp/microsoft.deb \
    && dpkg -i /tmp/microsoft.deb && rm /tmp/microsoft.deb \
    && apt-get update && apt-get install -y --no-install-recommends \
        build-essential file pkg-config git sudo unzip zip xz-utils wget \
        python3 python3-pip python-is-python3 powershell \
        libwebkit2gtk-4.1-dev libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev libfuse2 patchelf \
        dbus-x11 fonts-dejavu-core openbox x11-utils xauth xvfb \
    && rm -rf /var/lib/apt/lists/*

ARG GH_VERSION=2.105.0
ARG GH_SHA256=79e7ab5db738c48777b696e374f8b428f0647debfb424f44d2f426370407fe2f
RUN curl -fsSL --retry 3 "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" -o /tmp/gh.tar.gz \
    && echo "${GH_SHA256}  /tmp/gh.tar.gz" | sha256sum --check \
    && tar -xzf /tmp/gh.tar.gz --strip-components=2 -C /usr/local/bin "gh_${GH_VERSION}_linux_amd64/bin/gh" \
    && rm /tmp/gh.tar.gz

ARG RUNNER_VERSION=2.338.2
ARG RUNNER_SHA256=baebf204307bac6193480852732f0aba2ae97b6c5597c244f4d5558390147c40
RUN useradd --create-home --shell /bin/bash runner \
    && printf '%s\n' 'runner ALL=(root) NOPASSWD: /usr/bin/dpkg' > /etc/sudoers.d/dirlume-runner \
    && chmod 0440 /etc/sudoers.d/dirlume-runner \
    && mkdir /runner \
    && curl -fsSL --retry 3 "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz" -o /tmp/runner.tar.gz \
    && echo "${RUNNER_SHA256}  /tmp/runner.tar.gz" | sha256sum --check \
    && tar -xzf /tmp/runner.tar.gz -C /runner \
    && /runner/bin/installdependencies.sh \
    && chown -R runner:runner /runner \
    && rm /tmp/runner.tar.gz && rm -rf /var/lib/apt/lists/*

USER runner
ENV HOME=/home/runner
ENV PATH="/home/runner/.cargo/bin:${PATH}"
RUN curl -fsSL --retry 3 https://sh.rustup.rs | sh -s -- -y --no-modify-path --default-toolchain none

WORKDIR /runner
COPY --chmod=755 register.sh /usr/local/bin/register-dirlume-runner
CMD ["./run.sh"]
