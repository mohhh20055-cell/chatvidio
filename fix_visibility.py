import re

with open('/app/applet/public/teacher-dashboard.html', 'r', encoding='utf-8') as f:
    content = f.read()

pattern_upgrade = r'function updateUpgradeButtonsVisibility\(\) \{.*?\}'
new_upgrade = """function updateUpgradeButtonsVisibility() {
        if (!userData) return;
        const isCertified = Boolean(userData.is_certified === true || userData.status === 'certified');
        const isVerified = Boolean(userData.email_verified || userData.status === 'approved');
        const shouldShow = isVerified && !isCertified;
        
        document.querySelectorAll('.nav-upgrade-btn, .sidebar-upgrade-btn, .mobile-drawer-upgrade-item, .dropdown-upgrade-item, #teacherUpgradeBanner').forEach(el => {
            if (!el) return;
            if (!shouldShow) {
                el.style.display = 'none';
            } else {
                if (el.id === 'teacherUpgradeBanner' || el.classList.contains('dropdown-item') || el.classList.contains('mobile-drawer-upgrade-item')) {
                    el.style.display = 'flex';
                } else {
                    el.style.display = 'inline-flex';
                }
            }
        });
    }"""
content = re.sub(pattern_upgrade, new_upgrade, content, flags=re.DOTALL)

with open('/app/applet/public/teacher-dashboard.html', 'w', encoding='utf-8') as f:
    f.write(content)
