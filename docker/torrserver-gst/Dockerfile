# TorrServer build with GStreamer transcoding support.
#
# The stock ghcr.io/yourok/torrserver image ships a binary built WITHOUT
# the `gst` build tag, so it has no way to transcode HEVC/AV1/VP9 to H.264
# for clients (older TVs, etc.) that can't decode those codecs natively.
# There is no official pre-built image with gst enabled, but the project
# does publish a pre-built `TorrServer-gst-linux-amd64` binary on its
# GitHub Releases. That binary shells out to the gst-launch-1.0 /
# gst-discoverer-1.0 CLI tools at runtime (CGO_ENABLED=0 build, no
# compiled-in cgo bindings), so all we need is a runtime image with the
# GStreamer command-line tools and codec plugins installed.
FROM debian:bookworm-slim

ENV TS_CONF_PATH="/opt/ts/config"
ENV TS_LOG_PATH="/opt/ts/log"
ENV TS_TORR_DIR="/opt/ts/torrents"
ENV TS_PORT=8090
ENV GODEBUG=madvdontneed=1

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      wget \
      gstreamer1.0-tools \
      gstreamer1.0-plugins-base \
      gstreamer1.0-plugins-good \
      gstreamer1.0-plugins-bad \
      gstreamer1.0-plugins-ugly \
      gstreamer1.0-libav \
      gstreamer1.0-vaapi \
      i965-va-driver \
      vainfo \
    && rm -rf /var/lib/apt/lists/*

# Pinned to the release tag currently in use — bump deliberately when
# upgrading TorrServer, there is no "latest" gst asset to track.
ARG TS_VERSION=MatriX.144.1
RUN wget -q "https://github.com/YouROK/TorrServer/releases/download/${TS_VERSION}/TorrServer-gst-linux-amd64" -O /usr/bin/torrserver \
    && chmod +x /usr/bin/torrserver

COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 8090
CMD ["/docker-entrypoint.sh"]
