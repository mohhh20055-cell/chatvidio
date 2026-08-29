import re

with open('/app/applet/public/teacher-dashboard.html', 'r', encoding='utf-8') as f:
    content = f.read()

# Fix updateUpgradeButtonsVisibility
pattern_upgrade = r'function updateUpgradeButtonsVisibility\(\) \{.*?\}'
new_upgrade = """function updateUpgradeButtonsVisibility() {
        if (!userData) return;
        const isVerified = Boolean(userData.email_verified || userData.status === 'approved');
        document.querySelectorAll('.nav-upgrade-btn, .sidebar-upgrade-btn, .mobile-drawer-upgrade-item, .dropdown-upgrade-item').forEach(el => {
            el.style.display = isVerified ? 'inline-flex' : 'none';
        });
    }"""
content = re.sub(pattern_upgrade, new_upgrade, content, flags=re.DOTALL)

# Fix startStreamNow
pattern_stream = r'async function startStreamNow\(offerId\) \{.*?try \{'
new_stream = """async function startStreamNow(offerId) {
        if (checkGuestAction()) return;
        const shouldStart = confirm("⚠️ هل تريد بدء البث المباشر؟");
        if (!shouldStart) return;

        const autoAdmit = confirm("هل تريد إدخال الطلاب تلقائياً؟ (موافق: تلقائي، إلغاء: يدوياً)");
        if (autoAdmit) {
            await fetchWithAuth("/api/send-stream-notification", {
                method: "POST",
                body: JSON.stringify({ offer_id: offerId })
            });
        }
        try {"""
content = re.sub(pattern_stream, new_stream, content, flags=re.DOTALL)

with open('/app/applet/public/teacher-dashboard.html', 'w', encoding='utf-8') as f:
    f.write(content)
