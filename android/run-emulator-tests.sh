#!/usr/bin/env bash
set -u
test_exit=0
gradle --no-daemon --console=plain connectedDebugAndroidTest || test_exit=$?
mkdir -p app/build/reports/androidTests
adb logcat -d -s HUCaptionProbe:I HUCaptionExtractor:W HUBabelProbe:I > app/build/reports/androidTests/network-probe.txt
cat app/build/reports/androidTests/network-probe.txt
adb pull /sdcard/Android/data/hu.feliratauto.codexspeech/files/player-landscape.png app/build/reports/androidTests/ || true
adb pull /sdcard/Android/data/hu.feliratauto.codexspeech/files/player-portrait.png app/build/reports/androidTests/ || true
exit "$test_exit"
