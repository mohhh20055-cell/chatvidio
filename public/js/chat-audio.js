// ============================================================
// نظام الرسائل الصوتية الاحترافي (WhatsApp Style) - للمحادثات الفردية وغرف الدردشة
// ============================================================

let mediaRecorder = null;
let audioChunks = [];
let recordingStartTime = 0;
let recordingTimerInterval = null;
let activeRecordingStream = null;
let activeRecordingMode = null; // 'direct' | 'student-group' | 'teacher-group'
let isRecordingCanceled = false;

// حقن تنسيقات مشغل الصوت الاحترافي وشريط التسجيل
(function injectChatAudioStyles() {
    if (document.getElementById('chatAudioWhatsappStyles')) return;
    const style = document.createElement('style');
    style.id = 'chatAudioWhatsappStyles';
    style.textContent = `
        .audio-player-wrapper {
            display: flex !important;
            align-items: center !important;
            gap: 8px !important;
            padding: 7px 10px !important;
            border-radius: 16px !important;
            width: 100% !important;
            max-width: 100% !important;
            min-width: 0 !important;
            box-sizing: border-box !important;
            direction: ltr !important;
            user-select: none !important;
            position: relative !important;
            transition: all 0.2s ease !important;
        }
        .message-bubble.sent .audio-player-wrapper,
        .audio-player-wrapper.sent-audio {
            background: rgba(255, 255, 255, 0.16) !important;
            border: 1px solid rgba(255, 255, 255, 0.25) !important;
            color: #ffffff !important;
        }
        .message-bubble.received .audio-player-wrapper,
        .audio-player-wrapper.received-audio {
            background: #f8fafc !important;
            border: 1px solid #e2e8f0 !important;
            color: #0f172a !important;
        }
        .audio-player-wrapper .audio-play-btn {
            width: 36px !important;
            height: 36px !important;
            min-width: 36px !important;
            border-radius: 50% !important;
            border: none !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            cursor: pointer !important;
            font-size: 0.88rem !important;
            flex-shrink: 0 !important;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12) !important;
            transition: transform 0.15s ease, background 0.15s ease !important;
        }
        .audio-player-wrapper .audio-play-btn:active {
            transform: scale(0.92) !important;
        }
        .message-bubble.sent .audio-player-wrapper .audio-play-btn,
        .audio-player-wrapper.sent-audio .audio-play-btn {
            background: #ffffff !important;
            color: #2563eb !important;
        }
        .message-bubble.received .audio-player-wrapper .audio-play-btn,
        .audio-player-wrapper.received-audio .audio-play-btn {
            background: linear-gradient(135deg, #2563eb, #1d4ed8) !important;
            color: #ffffff !important;
        }
        .audio-body-col {
            flex: 1 1 auto !important;
            min-width: 0 !important;
            display: flex !important;
            flex-direction: column !important;
            gap: 5px !important;
        }
        .audio-timeline {
            width: 100% !important;
            min-width: 0 !important;
            height: 22px !important;
            position: relative !important;
            cursor: pointer !important;
            display: flex !important;
            align-items: center !important;
            background: transparent !important;
            border-radius: 6px !important;
            overflow: hidden !important;
        }
        .audio-waveform-bg {
            position: absolute !important;
            inset: 0 !important;
            display: flex !important;
            align-items: center !important;
            justify-content: space-between !important;
            gap: 2px !important;
            padding: 0 2px !important;
            pointer-events: none !important;
            opacity: 0.45 !important;
        }
        .audio-waveform-bar {
            flex: 1 !important;
            border-radius: 2px !important;
            background: currentColor !important;
            min-width: 2px !important;
            transition: opacity 0.15s ease !important;
        }
        .audio-progress {
            position: absolute !important;
            left: 0 !important;
            top: 50% !important;
            transform: translateY(-50%) !important;
            height: 4px !important;
            border-radius: 4px !important;
            width: 0% !important;
            pointer-events: none !important;
            transition: width 0.08s linear !important;
        }
        .message-bubble.sent .audio-progress,
        .audio-player-wrapper.sent-audio .audio-progress {
            background: #ffffff !important;
            box-shadow: 0 0 6px rgba(255,255,255,0.7) !important;
        }
        .message-bubble.received .audio-progress,
        .audio-player-wrapper.received-audio .audio-progress {
            background: #2563eb !important;
        }
        .audio-meta-row {
            display: flex !important;
            align-items: center !important;
            justify-content: space-between !important;
            gap: 4px !important;
            font-size: 0.72rem !important;
            line-height: 1 !important;
            width: 100% !important;
            min-width: 0 !important;
        }
        .audio-time {
            font-size: 0.72rem !important;
            font-weight: 700 !important;
            font-family: monospace, sans-serif !important;
            opacity: 0.9 !important;
            min-width: 28px !important;
            flex-shrink: 0 !important;
        }
        .message-bubble.sent .audio-time,
        .audio-player-wrapper.sent-audio .audio-time {
            color: rgba(255, 255, 255, 0.95) !important;
        }
        .message-bubble.received .audio-time,
        .audio-player-wrapper.received-audio .audio-time {
            color: #475569 !important;
        }
        .audio-controls-right {
            display: flex !important;
            align-items: center !important;
            gap: 4px !important;
            flex-shrink: 0 !important;
            visibility: visible !important;
            opacity: 1 !important;
        }
        .audio-speed-btn {
            border: none !important;
            border-radius: 8px !important;
            padding: 2px 6px !important;
            font-size: 0.7rem !important;
            font-weight: 800 !important;
            cursor: pointer !important;
            line-height: 1.2 !important;
            display: inline-flex !important;
            align-items: center !important;
            justify-content: center !important;
            width: auto !important;
            min-width: 26px !important;
            height: 22px !important;
            flex-shrink: 0 !important;
            visibility: visible !important;
            opacity: 1 !important;
            transition: all 0.15s ease !important;
        }
        .message-bubble.sent .audio-speed-btn,
        .audio-player-wrapper.sent-audio .audio-speed-btn {
            background: rgba(255, 255, 255, 0.22) !important;
            color: #ffffff !important;
        }
        .message-bubble.received .audio-speed-btn,
        .audio-player-wrapper.received-audio .audio-speed-btn {
            background: #e2e8f0 !important;
            color: #1e293b !important;
        }
        .audio-inline-delete-btn {
            border: none !important;
            border-radius: 8px !important;
            padding: 2px 7px !important;
            font-size: 0.74rem !important;
            cursor: pointer !important;
            display: inline-flex !important;
            align-items: center !important;
            justify-content: center !important;
            gap: 3px !important;
            width: auto !important;
            min-width: 26px !important;
            height: 22px !important;
            flex-shrink: 0 !important;
            visibility: visible !important;
            opacity: 1 !important;
            transition: all 0.15s ease !important;
        }
        .message-bubble.sent .audio-inline-delete-btn,
        .audio-player-wrapper.sent-audio .audio-inline-delete-btn {
            background: rgba(239, 68, 68, 0.35) !important;
            color: #ffffff !important;
            border: 1px solid rgba(255, 255, 255, 0.4) !important;
        }
        .message-bubble.received .audio-inline-delete-btn,
        .audio-player-wrapper.received-audio .audio-inline-delete-btn {
            background: #fef2f2 !important;
            color: #dc2626 !important;
            border: 1px solid #fecaca !important;
        }
        .btn-record {
            width: 42px !important;
            height: 42px !important;
            min-width: 42px !important;
            border-radius: 50% !important;
            border: 1.5px solid #dbeafe !important;
            background: #eff6ff !important;
            color: #2563eb !important;
            display: inline-flex !important;
            align-items: center !important;
            justify-content: center !important;
            font-size: 1.1rem !important;
            cursor: pointer !important;
            transition: all 0.2s ease !important;
            flex-shrink: 0 !important;
            padding: 0 !important;
        }
        .btn-record:hover {
            background: #dbeafe !important;
        }
        .btn-record.recording {
            background: #ef4444 !important;
            color: #ffffff !important;
            border-color: #dc2626 !important;
            box-shadow: 0 0 0 4px rgba(239, 68, 68, 0.25) !important;
            animation: recordPulseAnim 1.2s infinite !important;
        }
        @keyframes recordPulseAnim {
            0% { transform: scale(1); }
            50% { transform: scale(1.08); }
            100% { transform: scale(1); }
        }
        .voice-recording-banner {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 10px;
            background: #fef2f2;
            border: 1px solid #fecaca;
            border-radius: 14px;
            padding: 8px 14px;
            margin: 6px 10px;
            direction: rtl;
            animation: fadeIn 0.2s ease;
        }
        .voice-rec-dot {
            width: 10px;
            height: 10px;
            border-radius: 50%;
            background: #ef4444;
            display: inline-block;
            animation: recordPulseAnim 1s infinite;
        }
        @media (max-width: 640px) {
            .audio-player-wrapper {
                min-width: 250px !important;
                width: 100% !important;
                max-width: 100% !important;
                padding: 6px 8px !important;
                gap: 6px !important;
                box-sizing: border-box !important;
            }
            .audio-player-wrapper .audio-play-btn {
                width: 32px !important;
                height: 32px !important;
                min-width: 32px !important;
                font-size: 0.8rem !important;
                flex-shrink: 0 !important;
            }
            .audio-body-col {
                min-width: 150px !important;
                flex: 1 1 auto !important;
                gap: 4px !important;
            }
            .audio-timeline {
                height: 18px !important;
                min-width: 40px !important;
            }
            .audio-meta-row {
                width: 100% !important;
                display: flex !important;
                align-items: center !important;
                justify-content: space-between !important;
                gap: 4px !important;
            }
            .audio-time {
                font-size: 0.7rem !important;
                min-width: 28px !important;
                flex-shrink: 0 !important;
            }
            .audio-controls-right {
                display: flex !important;
                align-items: center !important;
                gap: 4px !important;
                flex-shrink: 0 !important;
                visibility: visible !important;
                opacity: 1 !important;
                z-index: 2 !important;
            }
            .audio-speed-btn {
                display: inline-flex !important;
                visibility: visible !important;
                opacity: 1 !important;
                align-items: center !important;
                justify-content: center !important;
                padding: 2px 6px !important;
                font-size: 0.72rem !important;
                font-weight: 800 !important;
                height: 24px !important;
                min-width: 28px !important;
                flex-shrink: 0 !important;
                border-radius: 6px !important;
            }
            .audio-inline-delete-btn {
                display: inline-flex !important;
                visibility: visible !important;
                opacity: 1 !important;
                align-items: center !important;
                justify-content: center !important;
                padding: 2px 7px !important;
                font-size: 0.75rem !important;
                height: 24px !important;
                min-width: 28px !important;
                flex-shrink: 0 !important;
                border-radius: 6px !important;
            }
            .voice-recording-banner {
                margin: 4px 6px !important;
                padding: 7px 10px !important;
                font-size: 0.82rem !important;
                border-radius: 12px !important;
                gap: 8px !important;
            }
            .message-bubble {
                max-width: 95% !important;
            }
            .message-content {
                max-width: 95% !important;
                padding: 8px 10px !important;
            }
            .message-actions-bar {
                opacity: 1 !important;
            }
        }
    `;
    document.head.appendChild(style);
})();

function formatAudioSeconds(sec) {
    const num = Number(sec);
    if (!isFinite(num) || isNaN(num) || num < 0) return '0:00';
    const totalSec = Math.round(num);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
}

function getPreferredAudioMimeType() {
    if (typeof MediaRecorder === 'undefined') return '';
    const types = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4',
        'audio/aac',
        'audio/ogg;codecs=opus'
    ];
    for (const t of types) {
        try {
            if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) {
                return t;
            }
        } catch (e) {}
    }
    return '';
}

function getAudioExtension(blob) {
    const t = String((blob && blob.type) || '').toLowerCase();
    if (t.includes('mp4') || t.includes('m4a')) return 'mp4';
    if (t.includes('aac')) return 'aac';
    if (t.includes('ogg')) return 'ogg';
    if (t.includes('wav')) return 'wav';
    if (t.includes('mp3') || t.includes('mpeg')) return 'mp3';
    return 'webm';
}

function getActiveUserIdAndType() {
    let uId = (typeof studentId !== 'undefined' && studentId && studentId !== -1) ? studentId : null;
    let uType = 'student';
    if (!uId && typeof teacherId !== 'undefined' && teacherId && teacherId !== -1) {
        uId = teacherId;
        uType = 'teacher';
    }
    if (!uId && typeof window.currentUserId !== 'undefined' && window.currentUserId) {
        uId = window.currentUserId;
    }
    if (!uId) {
        try {
            const raw = localStorage.getItem('user');
            if (raw) {
                const u = JSON.parse(raw);
                if (u && u.id && u.id !== -1) {
                    uId = u.id;
                    uType = u.role || (window.location.pathname.includes('teacher') ? 'teacher' : 'student');
                }
            }
        } catch(e) {}
    }
    return { id: uId, type: uType };
}

function showRecordingBanner(btnEl, mode) {
    removeRecordingBanner();
    if (!btnEl) return;
    
    // Find proper input bar container
    let parentBar = null;
    if (mode === 'student-group') {
        parentBar = document.getElementById('studentChatInputBar');
    } else if (mode === 'teacher-group') {
        parentBar = document.getElementById('teacherChatInputBar') || (document.getElementById('groupsChatView') ? document.getElementById('groupsChatView').querySelector('div:last-child') : null);
    }
    if (!parentBar) {
        parentBar = btnEl.closest('.chat-input-area') || btnEl.closest('#studentChatInputBar') || btnEl.closest('#teacherChatInputBar') || btnEl.parentElement;
    }
    if (!parentBar) return;

    const banner = document.createElement('div');
    banner.id = 'activeVoiceRecordingBanner';
    banner.className = 'voice-recording-banner';
    banner.innerHTML = `
        <div style="display:flex; align-items:center; gap:8px; color:#b91c1c; font-weight:800; font-size:0.85rem;">
            <span class="voice-rec-dot"></span>
            <span>جاري التسجيل الصوتي...</span>
            <span id="voiceRecordingLiveTimer" style="font-family:monospace; font-size:0.9rem; background:#fee2e2; padding:2px 8px; border-radius:8px; color:#991b1b;">0:00</span>
        </div>
        <div style="display:flex; align-items:center; gap:6px;">
            <button type="button" onclick="stopAndSendActiveRecording()" style="background:#16a34a; color:#fff; border:none; border-radius:20px; padding:6px 14px; font-size:0.8rem; font-weight:800; cursor:pointer; display:inline-flex; align-items:center; gap:5px; box-shadow:0 2px 6px rgba(22,163,74,0.3);">
                <i class="fas fa-paper-plane"></i> إرسال
            </button>
            <button type="button" onclick="cancelActiveRecording()" style="background:#ffffff; color:#dc2626; border:1px solid #fca5a5; border-radius:20px; padding:6px 12px; font-size:0.8rem; font-weight:800; cursor:pointer; display:inline-flex; align-items:center; gap:4px;">
                <i class="fas fa-times"></i> إلغاء
            </button>
        </div>
    `;
    if (parentBar.parentElement) {
        parentBar.parentElement.insertBefore(banner, parentBar);
    }
}

function removeRecordingBanner() {
    const existing = document.getElementById('activeVoiceRecordingBanner');
    if (existing) existing.remove();
    if (recordingTimerInterval) {
        clearInterval(recordingTimerInterval);
        recordingTimerInterval = null;
    }
    document.querySelectorAll('.btn-record.recording').forEach(b => {
        b.classList.remove('recording');
        b.innerHTML = '<i class="fas fa-microphone"></i>';
    });
}

function stopRecordingStream() {
    if (activeRecordingStream) {
        try {
            activeRecordingStream.getTracks().forEach(track => track.stop());
        } catch (e) {}
        activeRecordingStream = null;
    }
}

window.stopAndSendActiveRecording = function() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
        isRecordingCanceled = false;
        try {
            if (typeof mediaRecorder.requestData === 'function') {
                mediaRecorder.requestData();
            }
        } catch (e) {}
        try {
            mediaRecorder.stop();
        } catch (e) {
            console.warn('MediaRecorder stop error:', e);
        }
    }
};

window.cancelActiveRecording = function() {
    isRecordingCanceled = true;
    if (mediaRecorder && mediaRecorder.state === 'recording') {
        try { mediaRecorder.stop(); } catch (e) {}
    }
    stopRecordingStream();
    removeRecordingBanner();
    if (typeof showToast === 'function') {
        showToast('تم إلغاء التسجيل الصوتي', 'info');
    }
};

async function getAudioMediaStream() {
    if (navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function') {
        return await navigator.mediaDevices.getUserMedia({ audio: true });
    }
    const legacyGUM = navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia || navigator.msGetUserMedia;
    if (legacyGUM) {
        return new Promise((resolve, reject) => {
            legacyGUM.call(navigator, { audio: true }, resolve, reject);
        });
    }
    throw new Error('المتصفح لا يدعم الوصول للميكروفون');
}

async function startUnifiedRecording(mode, btnId) {
    const recordBtn = document.getElementById(btnId) || document.getElementById('recordBtn');

    if (mediaRecorder && mediaRecorder.state === 'recording') {
        isRecordingCanceled = false;
        try {
            if (typeof mediaRecorder.requestData === 'function') {
                mediaRecorder.requestData();
            }
        } catch (e) {}
        try {
            mediaRecorder.stop();
        } catch (e) {}
        return;
    }

    const activeDirectTeacher = window.currentChatTeacher || (typeof currentChatTeacher !== 'undefined' ? currentChatTeacher : null);
    const activeStudentGrp = window.activeStudentGroupId || window.currentStudentViewingGroupId || (typeof activeStudentGroupId !== 'undefined' ? activeStudentGroupId : null);
    const activeTeacherGrp = window.activeChatGroupId || window.currentTeacherViewingGroupId || (typeof activeChatGroupId !== 'undefined' ? activeChatGroupId : null);

    if (mode === 'direct' && !activeDirectTeacher) {
        if (typeof showToast === 'function') showToast('الرجاء اختيار محادثة أولاً', 'warning');
        return;
    }
    if (mode === 'student-group' && !activeStudentGrp) {
        if (typeof showToast === 'function') showToast('الرجاء فتح غرفة الدردشة أولاً', 'warning');
        return;
    }
    if (mode === 'teacher-group' && !activeTeacherGrp) {
        if (typeof showToast === 'function') showToast('الرجاء فتح غرفة الدردشة أولاً', 'warning');
        return;
    }

    try {
        const stream = await getAudioMediaStream();
        activeRecordingStream = stream;
        activeRecordingMode = mode;
        isRecordingCanceled = false;
        audioChunks = [];

        const mimeType = getPreferredAudioMimeType();
        try {
            mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
        } catch (e) {
            mediaRecorder = new MediaRecorder(stream);
        }

        mediaRecorder.ondataavailable = event => {
            if (event.data && event.data.size > 0) {
                audioChunks.push(event.data);
            }
        };

        mediaRecorder.onstop = async () => {
            const elapsedSeconds = Math.max(1, Math.round((Date.now() - recordingStartTime) / 1000));
            const finalMime = (mediaRecorder && mediaRecorder.mimeType) ? mediaRecorder.mimeType : (mimeType || 'audio/webm');
            stopRecordingStream();
            removeRecordingBanner();

            if (isRecordingCanceled || audioChunks.length === 0) {
                audioChunks = [];
                return;
            }

            const audioBlob = new Blob(audioChunks, { type: finalMime });
            audioChunks = [];

            if (audioBlob.size < 50) {
                if (typeof showToast === 'function') showToast('التسجيل قصير جداً، حاول مرة أخرى', 'warning');
                return;
            }

            try {
                if (activeRecordingMode === 'student-group' || activeRecordingMode === 'teacher-group') {
                    await sendGroupAudioMessage(audioBlob, elapsedSeconds, activeRecordingMode);
                } else {
                    await sendAudioMessage(audioBlob, elapsedSeconds);
                }
            } catch (err) {
                console.error('Error sending recorded audio:', err);
                if (typeof showToast === 'function') showToast('تعذر إرسال الرسالة الصوتية', 'error');
            }
        };

        recordingStartTime = Date.now();
        // Do NOT pass timeslice argument on mobile as it breaks Safari & some mobile WebViews
        try {
            mediaRecorder.start();
        } catch (e) {
            console.warn('Fallback starting MediaRecorder:', e);
            mediaRecorder.start();
        }

        if (recordBtn) {
            recordBtn.classList.add('recording');
            recordBtn.innerHTML = '<i class="fas fa-stop"></i>';
        }
        showRecordingBanner(recordBtn, mode);

        recordingTimerInterval = setInterval(() => {
            const sec = Math.max(0, Math.floor((Date.now() - recordingStartTime) / 1000));
            const timerEl = document.getElementById('voiceRecordingLiveTimer');
            if (timerEl) timerEl.textContent = formatAudioSeconds(sec);
        }, 500);
    } catch (err) {
        console.error('Error accessing microphone:', err);
        stopRecordingStream();
        removeRecordingBanner();
        if (typeof showToast === 'function') {
            showToast('تعذر الوصول إلى الميكروفون، يرجى السماح بصلاحية الميكروفون في المتصفح', 'error');
        }
    }
}

async function toggleRecording() {
    await startUnifiedRecording('direct', 'recordBtn');
}
window.toggleRecording = toggleRecording;

async function toggleGroupRecording(roleMode) {
    if (roleMode === 'teacher') {
        await startUnifiedRecording('teacher-group', 'teacherGroupRecordBtn');
    } else {
        await startUnifiedRecording('student-group', 'studentGroupRecordBtn');
    }
}
window.toggleGroupRecording = toggleGroupRecording;

let isSendingAudio = false;

async function sendAudioMessage(audioBlob, recordedDuration = 1) {
    if (isSendingAudio) return;
    const activeTeacher = window.currentChatTeacher || (typeof currentChatTeacher !== 'undefined' ? currentChatTeacher : null);
    if (!activeTeacher) return;

    const user = getActiveUserIdAndType();
    if (!user.id) return;

    isSendingAudio = true;
    const ext = getAudioExtension(audioBlob);
    const formData = new FormData();
    formData.append('audio', audioBlob, `voice-message.${ext}`);
    formData.append('sender_id', user.id);
    formData.append('sender_type', user.type);
    formData.append('receiver_id', activeTeacher.id);
    formData.append('receiver_type', activeTeacher.type || (user.type === 'student' ? 'teacher' : 'student'));
    formData.append('duration', Math.max(1, Math.round(recordedDuration || 1)));

    try {
        if (typeof showToast === 'function') showToast('🎙️ جاري إرسال الرسالة الصوتية...', 'info');
        const token = localStorage.getItem('token');
        const res = await fetch('/api/messages/send-audio', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + token },
            body: formData
        });
        const data = await res.json();
        if (data.success) {
            if (typeof loadConversationMessages === 'function') {
                await loadConversationMessages(activeTeacher.id, activeTeacher.type || (user.type === 'student' ? 'teacher' : 'student'));
            }
            if (typeof loadConversations === 'function') {
                loadConversations(true);
            }
        } else {
            if (typeof showToast === 'function' && !data.error?.includes('انتظار')) {
                showToast('خطأ في إرسال الرسالة الصوتية: ' + (data.error || ''), 'error');
            }
        }
    } catch (e) {
        console.error('Error sending audio:', e);
    } finally {
        isSendingAudio = false;
    }
}

async function sendGroupAudioMessage(audioBlob, recordedDuration = 1, mode = 'student-group') {
    if (isSendingAudio) return;
    const groupId = mode === 'teacher-group'
        ? (window.activeChatGroupId || window.currentTeacherViewingGroupId || (typeof activeChatGroupId !== 'undefined' ? activeChatGroupId : null))
        : (window.activeStudentGroupId || window.currentStudentViewingGroupId || (typeof activeStudentGroupId !== 'undefined' ? activeStudentGroupId : null));

    if (!groupId) {
        if (typeof showToast === 'function') showToast('لم يتم العثور على معرّف المجموعة، افتح المجموعة أولاً', 'warning');
        return;
    }

    isSendingAudio = true;

    const ext = getAudioExtension(audioBlob);
    const formData = new FormData();
    formData.append('file', audioBlob, `voice-message.${ext}`);

    try {
        if (typeof showToast === 'function') showToast('🎙️ جاري إرسال الرسالة الصوتية في الغرفة...', 'info');
        const token = localStorage.getItem('token');
        const uploadRes = await fetch(`/api/groups/${groupId}/upload-file`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` },
            body: formData
        });
        const uploadData = await uploadRes.json();
        if (!uploadRes.ok || uploadData.error || !uploadData.file_url) {
            throw new Error(uploadData.error || 'فشل رفع التسجيل الصوتي');
        }

        const durSec = Math.max(1, Math.round(recordedDuration || 1));
        const replyObj = (typeof currentGroupReplyTo !== 'undefined' && currentGroupReplyTo) ? currentGroupReplyTo : null;

        const payload = {
            message: '',
            file_url: uploadData.file_url,
            file_name: `voice-message.${ext}`,
            file_size: durSec,
            file_type: 'audio',
            audio_url: uploadData.file_url,
            audio_duration: durSec,
            message_type: 'audio',
            reply_to_id: replyObj ? replyObj.id : null,
            reply_to_sender: replyObj ? replyObj.sender : null,
            reply_to_text: replyObj ? replyObj.text : null
        };

        const msgRes = await fetch(`/api/groups/${groupId}/messages`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify(payload)
        });
        const msgData = await msgRes.json();
        if (!msgRes.ok || msgData.error) {
            throw new Error(msgData.error || 'فشل إرسال الرسالة الصوتية');
        }

        if (typeof cancelGroupChatReply === 'function') cancelGroupChatReply();
        if (mode === 'teacher-group') {
            const loadFn = window.loadChatMessages || (typeof loadChatMessages === 'function' ? loadChatMessages : null);
            if (loadFn) await loadFn();
            const area = document.getElementById('chatMessagesArea');
            if (area) area.scrollTop = area.scrollHeight;
        } else {
            const loadFn = window.loadStudentChatMessages || (typeof loadStudentChatMessages === 'function' ? loadStudentChatMessages : null);
            if (loadFn) await loadFn();
            const area = document.getElementById('studentChatMessagesArea');
            if (area) area.scrollTop = area.scrollHeight;
        }
    } catch (err) {
        console.error('Error sending group audio message:', err);
        if (typeof showToast === 'function' && !err.message?.includes('انتظار')) {
            showToast(err.message || 'فشل إرسال الرسالة الصوتية', 'error');
        }
    } finally {
        isSendingAudio = false;
    }
}

// بناء HTML لمشغل الرسالة الصوتية بتصميم واتساب
window.renderVoiceMessageHtml = function(msg, isSent, options = {}) {
    const audioUrl = msg.audio_url || msg.file_url || '';
    const durSec = Number(msg.audio_duration || msg.file_size || 0);
    const initialTimeStr = durSec > 0 ? formatAudioSeconds(durSec) : '0:01';
    const canDelete = options.canDelete !== undefined ? !!options.canDelete : (isSent !== undefined ? !!isSent : true);
    let deleteJs = options.deleteJs;
    if (!deleteJs && msg && msg.id) {
        deleteJs = options.isGroup ? `confirmDeleteGroupMessage(event, '${msg.id}')` : `deleteMessage(${msg.id})`;
    }

    if (!audioUrl || audioUrl === 'undefined' || audioUrl === 'null') {
        return `
            <div class="audio-player-wrapper ${isSent ? 'sent-audio' : 'received-audio'}" style="opacity: 0.65; width: 265px;">
                <button type="button" class="audio-play-btn" disabled style="cursor: not-allowed; opacity: 0.5;">
                    <i class="fas fa-exclamation-triangle" style="color: #ef4444;"></i>
                </button>
                <div class="audio-body-col" style="justify-content: center;">
                    <span style="font-size: 0.72rem; font-weight: bold; color: ${isSent ? '#ffffff' : '#dc2626'};">⚠️ الرسالة الصوتية غير متوفرة أو تالفة</span>
                </div>
            </div>
        `;
    }

    // توليد أعمدة الموجة الصوتية بشكل متناسق
    const heights = [35, 55, 75, 45, 85, 60, 95, 50, 70, 80, 40, 90, 65, 50, 85, 60, 40, 75, 55, 45];
    const barsHtml = heights.map(h => `<span class="audio-waveform-bar" style="height:${h}%;"></span>`).join('');

    return `
        <div class="audio-player-wrapper ${isSent ? 'sent-audio' : 'received-audio'}" data-duration="${durSec > 0 ? durSec : 1}">
            <button type="button" class="audio-play-btn" onclick="event.stopPropagation(); toggleAudio(this)" title="تشغيل / إيقاف">
                <i class="fas fa-play"></i>
            </button>
            <div class="audio-body-col">
                <div class="audio-timeline" onclick="event.stopPropagation(); seekAudio(event)">
                    <div class="audio-waveform-bg">${barsHtml}</div>
                    <div class="audio-progress"></div>
                </div>
                <div class="audio-meta-row">
                    <span class="audio-time">${initialTimeStr}</span>
                    <div class="audio-controls-right">
                        <button type="button" class="audio-speed-btn" onclick="event.stopPropagation(); toggleAudioSpeed(this)" title="سرعة التشغيل">1x</button>
                        ${canDelete && deleteJs ? `
                            <button type="button" class="audio-inline-delete-btn" onclick="event.stopPropagation(); ${deleteJs}" title="حذف الرسالة الصوتية">
                                <i class="fas fa-trash-alt"></i>
                            </button>
                        ` : ''}
                    </div>
                </div>
            </div>
            <audio src="${audioUrl}" preload="metadata" data-duration="${durSec > 0 ? durSec : 1}" onloadedmetadata="setDuration(this)" ontimeupdate="updateAudioTime(this)" onended="resetAudio(this)"></audio>
        </div>
    `;
};

window.isAnyChatAudioPlaying = function() {
    const audios = document.querySelectorAll('.audio-player-wrapper audio');
    for (const a of audios) {
        if (!a.paused && !a.ended) return true;
    }
    return false;
};

function getEffectiveAudioDuration(audioEl, wrapper) {
    if (audioEl && isFinite(audioEl.duration) && !isNaN(audioEl.duration) && audioEl.duration > 0) {
        return audioEl.duration;
    }
    const attrDur = Number(
        (audioEl && audioEl.getAttribute('data-duration')) ||
        (wrapper && wrapper.getAttribute('data-duration')) ||
        0
    );
    return (isFinite(attrDur) && attrDur > 0) ? attrDur : 1;
}

function toggleAudio(el) {
    if (!el) return;
    const wrapper = el.closest ? el.closest('.audio-player-wrapper') : null;
    if (!wrapper) {
        console.warn('toggleAudio: Could not find .audio-player-wrapper for element:', el);
        return;
    }
    const audioEl = wrapper.querySelector('audio');
    if (!audioEl) {
        console.warn('toggleAudio: Could not find audio element inside wrapper');
        return;
    }

    const btnIcon = wrapper.querySelector('.audio-play-btn i') || wrapper.querySelector('button i');

    // إيقاف أي رسالة صوتية أخرى قيد التشغيل
    try {
        document.querySelectorAll('.audio-player-wrapper audio').forEach(otherAudio => {
            if (otherAudio && otherAudio !== audioEl && !otherAudio.paused) {
                try {
                    otherAudio.pause();
                } catch (e) {}
                const otherWrap = otherAudio.closest('.audio-player-wrapper');
                if (otherWrap) {
                    const otherIcon = otherWrap.querySelector('.audio-play-btn i') || otherWrap.querySelector('button i');
                    if (otherIcon) otherIcon.className = 'fas fa-play';
                }
            }
        });
    } catch (e) {
        console.warn('Error pausing other audios:', e);
    }

    const audioUrl = audioEl.getAttribute('src') || '';

    if (audioEl.paused) {
        audioEl.play().then(() => {
            if (btnIcon) btnIcon.className = 'fas fa-pause';
        }).catch(err => {
            console.error('Audio play failed:', err);
            let errorMessage = 'تعذر تشغيل الملف الصوتي';
            if (err.name === 'NotSupportedError' || err.message.includes('supported sources') || err.message.includes('supported')) {
                if (audioUrl.includes('.webm') && (/iPad|iPhone|iPod/.test(navigator.userAgent) || /^((?!chrome|android).)*safari/i.test(navigator.userAgent))) {
                    errorMessage = 'متصفح سفاري على آيفون/آيباد لا يدعم تشغيل صيغة WebM. يرجى استخدام متصفح كروم/أندرويد أو تطبيق يدعمها لتشغيل الرسالة.';
                } else {
                    errorMessage = 'الملف الصوتي غير متوفر أو صيغته غير مدعومة على هذا الجهاز.';
                }
            }
            if (typeof showToast === 'function') showToast(errorMessage, 'error');
            else if (typeof showNotification === 'function') showNotification('❌ ' + errorMessage, 'error');
            else if (typeof alert === 'function') alert(errorMessage);
        });
    } else {
        audioEl.pause();
        if (btnIcon) btnIcon.className = 'fas fa-play';
    }
}
window.toggleAudio = toggleAudio;

function toggleAudioSpeed(btnEl) {
    if (!btnEl) return;
    const wrapper = btnEl.closest('.audio-player-wrapper');
    if (!wrapper) return;
    const audioEl = wrapper.querySelector('audio');
    if (!audioEl) return;

    const speeds = [1, 1.5, 2];
    const currentRate = audioEl.playbackRate || 1;
    const nextIdx = (speeds.indexOf(currentRate) + 1) % speeds.length;
    const nextSpeed = speeds[nextIdx];
    audioEl.playbackRate = nextSpeed;
    btnEl.textContent = `${nextSpeed}x`;
}
window.toggleAudioSpeed = toggleAudioSpeed;

function updateAudioTime(audioEl) {
    if (!audioEl) return;
    const wrapper = audioEl.closest('.audio-player-wrapper');
    if (!wrapper) return;

    const progress = wrapper.querySelector('.audio-progress');
    const timeDisplay = wrapper.querySelector('.audio-time');
    const totalDur = getEffectiveAudioDuration(audioEl, wrapper);
    const current = isFinite(audioEl.currentTime) ? audioEl.currentTime : 0;

    if (progress && totalDur > 0) {
        const percent = Math.min(100, Math.max(0, (current / totalDur) * 100));
        progress.style.width = percent + '%';
    }
    if (timeDisplay) {
        timeDisplay.textContent = formatAudioSeconds(current);
    }
}
window.updateAudioTime = updateAudioTime;

function resetAudio(audioEl) {
    if (!audioEl) return;
    const wrapper = audioEl.closest('.audio-player-wrapper');
    if (!wrapper) return;

    audioEl.currentTime = 0;
    const btnIcon = wrapper.querySelector('.audio-play-btn i') || wrapper.querySelector('button i');
    if (btnIcon) btnIcon.className = 'fas fa-play';

    const progress = wrapper.querySelector('.audio-progress');
    if (progress) progress.style.width = '0%';

    const timeDisplay = wrapper.querySelector('.audio-time');
    const totalDur = getEffectiveAudioDuration(audioEl, wrapper);
    if (timeDisplay) {
        timeDisplay.textContent = formatAudioSeconds(totalDur);
    }
}
window.resetAudio = resetAudio;

function setDuration(audioEl) {
    if (!audioEl) return;
    const wrapper = audioEl.closest('.audio-player-wrapper');
    if (!wrapper) return;

    const timeDisplay = wrapper.querySelector('.audio-time');
    if (isFinite(audioEl.duration) && !isNaN(audioEl.duration) && audioEl.duration > 0) {
        const d = Math.max(1, Math.round(audioEl.duration));
        audioEl.setAttribute('data-duration', d);
        wrapper.setAttribute('data-duration', d);
        if (timeDisplay) timeDisplay.textContent = formatAudioSeconds(d);
    } else {
        const fallbackDur = getEffectiveAudioDuration(audioEl, wrapper);
        if (timeDisplay) timeDisplay.textContent = formatAudioSeconds(fallbackDur);
    }
}
window.setDuration = setDuration;

function seekAudio(event) {
    if (!event) return;
    const timeline = event.currentTarget;
    if (!timeline) return;
    const wrapper = timeline.closest('.audio-player-wrapper');
    if (!wrapper) return;
    const audioEl = wrapper.querySelector('audio');
    if (!audioEl) return;

    const rect = timeline.getBoundingClientRect();
    if (!rect.width) return;
    const clickX = event.clientX - rect.left;
    const percent = Math.min(1, Math.max(0, clickX / rect.width));
    const totalDur = getEffectiveAudioDuration(audioEl, wrapper);
    if (totalDur > 0 && isFinite(totalDur)) {
        audioEl.currentTime = percent * totalDur;
        updateAudioTime(audioEl);
    }
}
window.seekAudio = seekAudio;
