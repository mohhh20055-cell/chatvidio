import re

with open('/app/applet/public/teacher-dashboard.html', 'r', encoding='utf-8') as f:
    content = f.read()

pattern_stream = r'async function startStreamNow\(offerId\) \{.*?try \{.*?const data = await res\.json\(\);\s*if \(data\.success\) \{'
new_stream = """async function startStreamNow(offerId) {
        if (checkGuestAction()) return;
        const shouldStart = confirm("⚠️ هل تريد بدء البث المباشر؟");
        if (!shouldStart) return;

        const autoAdmit = confirm("سيتم الآن بدء البث. هل تريد إدخال جميع الطلاب المسجلين تلقائياً الآن؟ (موافق: نعم تلقائي، إلغاء: لا، سأقوم بإدخالهم يدوياً)");

        try {
            const res = await fetchWithAuth('/api/start-agora-stream', {
                method: 'POST',
                body: JSON.stringify({ offer_id: offerId })
            });
            const data = await res.json();
            if (data.success) {
                if (autoAdmit) {
                    await fetchWithAuth(`/api/stream/add-all-students/${offerId}`, {
                        method: 'POST',
                        body: JSON.stringify({ teacher_id: userData ? userData.id : 0 })
                    });
                }
"""

content = re.sub(pattern_stream, new_stream, content, flags=re.DOTALL)

with open('/app/applet/public/teacher-dashboard.html', 'w', encoding='utf-8') as f:
    f.write(content)
