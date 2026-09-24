#!/bin/bash
# WebM master + narration WAV -> one H.264/AAC MP4, in a single VLC pass.
# (AVFoundation passthrough refuses VLC's MP4 output, so we mux at transcode time instead.)
set -u
IN="$1"; AUDIO="$2"; OUT="$3"
"/Applications/VLC.app/Contents/MacOS/VLC" -I dummy --no-repeat --no-loop \
  "$IN" --input-slave="file://$AUDIO" \
  --sout "#transcode{vcodec=h264,vb=5000,venc=x264{profile=high,level=4.0,preset=slow},fps=30,acodec=mp4a,ab=128,channels=1,samplerate=44100}:standard{access=file,mux=mp4,dst=$OUT}" \
  vlc://quit >/dev/null 2>&1
echo "vlc exit=$?"
[ -s "$OUT" ] && echo "wrote $OUT ($(du -h "$OUT" | cut -f1))" || echo "NO OUTPUT"
