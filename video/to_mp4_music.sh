#!/bin/bash
# WebM master + a stereo music WAV -> H.264/AAC MP4 in one VLC pass.
# Same as to_mp4_narrated.sh but keeps two channels: narration was mono, music is not.
set -u
IN="$1"; AUDIO="$2"; OUT="$3"
"/Applications/VLC.app/Contents/MacOS/VLC" -I dummy --no-repeat --no-loop \
  "$IN" --input-slave="file://$AUDIO" \
  --sout "#transcode{vcodec=h264,vb=5000,venc=x264{profile=high,level=4.0,preset=slow},fps=30,acodec=mp4a,ab=160,channels=2,samplerate=44100}:standard{access=file,mux=mp4,dst=$OUT}" \
  vlc://quit >/dev/null 2>&1
echo "vlc exit=$?"
[ -s "$OUT" ] && echo "wrote $OUT ($(du -h "$OUT" | cut -f1))" || echo "NO OUTPUT"
