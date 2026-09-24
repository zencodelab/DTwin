#!/bin/bash
# WebM/VP8 -> H.264 MP4 using VLC's CLI (no install; AVFoundation can't read VP8, so avconvert is out)
set -u
IN="$1"; OUT="$2"
"/Applications/VLC.app/Contents/MacOS/VLC" -I dummy --no-repeat --no-loop "$IN" \
  --sout "#transcode{vcodec=h264,vb=5000,venc=x264{profile=high,level=4.0,preset=slow},acodec=none,fps=30}:standard{access=file,mux=mp4,dst=$OUT}" \
  vlc://quit >/dev/null 2>&1
rc=$?
echo "vlc exit=$rc"
[ -s "$OUT" ] && echo "wrote $OUT ($(du -h "$OUT" | cut -f1))" || echo "NO OUTPUT"
