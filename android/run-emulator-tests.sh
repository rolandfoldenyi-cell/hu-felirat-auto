#!/usr/bin/env bash
set -u
test_exit=0
gradle --no-daemon --console=plain connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=hu.feliratauto.android.BabelAudioProbeTest || test_exit=$?
mkdir -p app/build/reports/androidTests
adb logcat -d -s HUCaptionProbe:I HUCaptionExtractor:W HUBabelProbe:I > app/build/reports/androidTests/network-probe.txt
cat app/build/reports/androidTests/network-probe.txt
exit "$test_exit"
