package com.choidev.choibuddy

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import kotlin.concurrent.thread

/**
 * 승인 알림의 [허용]/[거부] 버튼. 결정은 그 요청을 보낸 PC(알림에 실어 둔 주소)로 보낸다.
 * 네트워크를 타야 해서 goAsync로 잠깐 더 살아 있는다.
 */
class DecisionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val decision = Notifications.decisionOf(intent) ?: return
        val pendingId = decision.notice.pendingId
        // 기기 코드는 지금 저장된 것을 쓴다. 그 사이 다시 연결해 코드가 바뀌었어도 보낼 수 있다.
        val pairing = Prefs(context).pairings.firstOrNull { it.baseUrl == decision.route.baseUrl }
        if (pairing == null) {
            Notifications.cancelPending(context, pendingId)
            return
        }

        val result = goAsync()
        thread(name = "choibuddy-decide") {
            try {
                if (Bridge.decide(pairing, pendingId, decision.behavior)) {
                    Notifications.cancelPending(context, pendingId)
                } else {
                    Notifications.showPending(context, decision.notice.copy(sendFailed = true), decision.route)
                }
            } finally {
                result.finish()
            }
        }
    }
}
