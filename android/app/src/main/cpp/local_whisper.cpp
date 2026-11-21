// SPDX-License-Identifier: GPL-3.0-or-later
#include <jni.h>
#include <whisper.h>
#include <algorithm>
#include <atomic>
#include <cctype>
#include <cstdint>
#include <fstream>
#include <iomanip>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

static std::atomic<uint64_t> generation{0};
struct Progress { JNIEnv *env; jobject listener; jmethodID method; };
static bool abort_work(void *request) { return generation.load() != *static_cast<uint64_t *>(request); }
static void report(whisper_context *, whisper_state *, int percent, void *data) {
    auto *progress = static_cast<Progress *>(data);
    progress->env->CallVoidMethod(progress->listener, progress->method, percent);
}
static std::string text(JNIEnv *env, jstring value) {
    const char *raw = env->GetStringUTFChars(value, nullptr);
    std::string result(raw); env->ReleaseStringUTFChars(value, raw); return result;
}
static std::string timestamp(int64_t ticks) {
    int64_t millis = ticks * 10;
    std::ostringstream output;
    output << std::setfill('0') << std::setw(2) << millis / 3600000 << ':'
           << std::setw(2) << (millis / 60000) % 60 << ':' << std::setw(2) << (millis / 1000) % 60
           << '.' << std::setw(3) << millis % 1000;
    return output.str();
}
extern "C" JNIEXPORT void JNICALL Java_hu_feliratauto_android_LocalSpeech_cancelNative(JNIEnv *, jclass) { generation.fetch_add(1); }
extern "C" JNIEXPORT jlong JNICALL Java_hu_feliratauto_android_LocalSpeech_beginNative(JNIEnv *, jclass) { return static_cast<jlong>(generation.load()); }
extern "C" JNIEXPORT jbyteArray JNICALL Java_hu_feliratauto_android_LocalSpeech_transcribeNative(
        JNIEnv *env, jclass, jstring model_value, jstring vad_value, jstring pcm_value, jint threads, jlong request, jobject listener) {
    try {
        auto token = static_cast<uint64_t>(request);
        const auto model = text(env, model_value), vad = text(env, vad_value), pcm = text(env, pcm_value);
        std::ifstream input(pcm, std::ios::binary | std::ios::ate);
        if (!input) throw std::runtime_error("A feldolgozott hangsáv nem olvasható.");
        const auto bytes = input.tellg();
        if (bytes <= 0 || bytes > 16000LL * 2 * 3600) throw std::runtime_error("A hangsáv mérete nem támogatott.");
        input.seekg(0);
        std::vector<float> samples; samples.reserve(static_cast<size_t>(bytes) / 2);
        int16_t buffer[16384];
        while (input.read(reinterpret_cast<char *>(buffer), sizeof(buffer)) || input.gcount() > 0) {
            if (generation.load() != token) throw std::runtime_error("Megszakított beszédfelismerés.");
            const auto count = input.gcount() / 2;
            for (int64_t index = 0; index < count; index++) samples.push_back(buffer[index] / 32768.0f);
        }
        auto context_params = whisper_context_default_params(); context_params.use_gpu = false;
        std::unique_ptr<whisper_context, decltype(&whisper_free)> context(
            whisper_init_from_file_with_params(model.c_str(), context_params), whisper_free);
        if (!context) throw std::runtime_error("A beszédfelismerő nem indítható.");
        Progress progress{env, listener, env->GetMethodID(env->GetObjectClass(listener), "percent", "(I)V")};
        auto params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
        params.n_threads = std::clamp(static_cast<int>(threads), 1, 4);
        params.translate = false; params.language = "en"; params.no_context = true;
        params.print_progress = false; params.print_realtime = false; params.print_timestamps = false; params.print_special = false;
        params.suppress_blank = true; params.suppress_nst = true;
        params.token_timestamps = true; params.max_len = 90; params.split_on_word = true;
        params.vad = true; params.vad_model_path = vad.c_str();
        params.abort_callback = abort_work;
        params.abort_callback_user_data = &token;
        params.progress_callback = report; params.progress_callback_user_data = &progress;
        if (whisper_full(context.get(), params, samples.data(), static_cast<int>(samples.size())) != 0) throw std::runtime_error("A beszédfelismerés megszakadt vagy nem sikerült.");
        if (generation.load() != token) throw std::runtime_error("Megszakított beszédfelismerés.");
        std::ostringstream output; output << "WEBVTT\n\n";
        const int64_t duration_ticks = static_cast<int64_t>(samples.size()) / 160;
        for (int index = 0; index < whisper_full_n_segments(context.get()); index++) {
            std::string words = whisper_full_get_segment_text(context.get(), index);
            std::replace(words.begin(), words.end(), '\n', ' '); std::replace(words.begin(), words.end(), '\r', ' ');
            bool speech = std::any_of(words.begin(), words.end(), [](unsigned char c) { return std::isalpha(c); });
            int64_t start = std::max<int64_t>(0, whisper_full_get_segment_t0(context.get(), index));
            int64_t end = std::min<int64_t>(duration_ticks, whisper_full_get_segment_t1(context.get(), index));
            if (!speech || end <= start) continue;
            output << timestamp(start) << " --> " << timestamp(end) << '\n' << words << "\n\n";
        }
        auto value = output.str();
        auto result = env->NewByteArray(static_cast<jsize>(value.size()));
        env->SetByteArrayRegion(result, 0, static_cast<jsize>(value.size()), reinterpret_cast<const jbyte *>(value.data()));
        return result;
    } catch (const std::exception &error) {
        env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), error.what());
        return nullptr;
    }
}
