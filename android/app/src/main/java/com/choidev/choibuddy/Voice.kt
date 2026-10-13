package com.choidev.choibuddy

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import org.json.JSONObject

/**
 * 말로 입력: 휴대폰의 음성 인식(SpeechRecognizer)으로 듣고, 들리는 대로 중간 결과와 끝 결과를 UI로 넘긴다.
 * 시스템 대화상자는 띄우지 않는다. 메인 스레드에서만 부른다.
 */
class Voice(private val context: Context, private val emit: (JSONObject) -> Unit) {
    private var recognizer: SpeechRecognizer? = null

    fun available(): Boolean = SpeechRecognizer.isRecognitionAvailable(context)

    /** [language]는 BCP 47 태그(ko-KR 등). 이미 듣고 있으면 처음부터 다시 듣는다. */
    fun start(language: String) {
        destroy()

        val next = SpeechRecognizer.createSpeechRecognizer(context)

        next.setRecognitionListener(Listener())
        recognizer = next
        next.startListening(
            Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE, language)
                .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true),
        )
    }

    /** 듣기를 끝낸다. 그때까지 들은 말이 끝 결과로 온다. */
    fun stop() {
        recognizer?.stopListening()
    }

    fun destroy() {
        recognizer?.destroy()
        recognizer = null
    }

    private fun send(kind: String, text: String? = null) {
        emit(JSONObject().put("kind", kind).put("text", text ?: ""))
    }

    private inner class Listener : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) = send("listening")

        override fun onPartialResults(partialResults: Bundle?) = send("partial", firstOf(partialResults))

        override fun onResults(results: Bundle?) {
            send("final", firstOf(results))
            destroy()
        }

        override fun onError(error: Int) {
            // 아무 말도 없이 끝난 것도 오류로 온다: 들은 게 없다는 뜻이다.
            send(if (error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) "final" else "error")
            destroy()
        }

        override fun onBeginningOfSpeech() = Unit

        override fun onRmsChanged(rmsdB: Float) = Unit

        override fun onBufferReceived(buffer: ByteArray?) = Unit

        override fun onEndOfSpeech() = Unit

        override fun onEvent(eventType: Int, params: Bundle?) = Unit
    }

    private fun firstOf(bundle: Bundle?): String = bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull() ?: ""
}
