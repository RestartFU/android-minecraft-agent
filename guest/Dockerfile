# redroid 13 (Android 13) with MindTheGapps overlaid, so Google Play works.
# Build in the guest:  docker build -t lunar/redroid13-gapps .
#
# MindTheGapps only ships x86_64 up to Android 13, which is why this is redroid 13.
# Bedrock needs only Android 8+, so that's fine.
FROM debian:bookworm-slim AS fetch
ARG GAPPS_URL=https://github.com/MindTheGapps/13.0.0-x86_64/releases/download/MindTheGapps-13.0.0-x86_64-20231025_201203/MindTheGapps-13.0.0-x86_64-20231025_201203.zip
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fL "$GAPPS_URL" -o /mtg.zip \
 && mkdir -p /mtg && unzip -q /mtg.zip -d /mtg

FROM redroid/redroid:13.0.0-latest
COPY --from=fetch /mtg/system/ /system/
