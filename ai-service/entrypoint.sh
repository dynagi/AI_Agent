#!/bin/sh
# Starts as root only to hand the runtime-data directory to the service user (a mounted disk, e.g. on Render, is
# created root-owned), then runs the service as that user.
chown -R aura /app/app/data 2>/dev/null || true
exec runuser -u aura -- "$@"
