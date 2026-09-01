(function () {
  'use strict';

  const COMMUNITY_URL = 'https://t.me/ZoomDZ_Group';
  const styles = `
    .zoomdz-community-modal{position:fixed;inset:0;z-index:100000;display:none;align-items:center;justify-content:center;padding:16px;background:rgba(15,23,42,.72);backdrop-filter:blur(6px);font-family:Cairo,Arial,sans-serif}
    .zoomdz-community-modal.is-open{display:flex}
    .zoomdz-community-card{width:min(100%,420px);background:#fff;color:#172033;border-radius:22px;padding:28px 24px;text-align:center;box-shadow:0 24px 70px rgba(0,0,0,.28);animation:zoomdzCommunityIn .25s ease-out}
    .zoomdz-community-icon{width:72px;height:72px;margin:0 auto 16px;border-radius:50%;background:#229ed9;color:#fff;display:flex;align-items:center;justify-content:center;font-size:38px}
    .zoomdz-community-card h2{margin:0 0 10px;font-size:1.35rem;color:#123b70}
    .zoomdz-community-card p{margin:0 0 22px;line-height:1.9;font-size:.98rem;color:#475569}
    .zoomdz-community-actions{display:flex;gap:10px;justify-content:center;flex-wrap:wrap}
    .zoomdz-community-join,.zoomdz-community-close{border:0;border-radius:12px;padding:12px 18px;font:inherit;font-weight:700;cursor:pointer;text-decoration:none}
    .zoomdz-community-join{background:#229ed9;color:#fff;box-shadow:0 6px 16px rgba(34,158,217,.28)}
    .zoomdz-community-close{background:#e8eef5;color:#334155}
    @keyframes zoomdzCommunityIn{from{opacity:0;transform:translateY(12px) scale(.97)}to{opacity:1;transform:none}}
  `;

  function getRole() {
    try {
      const raw = localStorage.getItem('userData') || localStorage.getItem('zoomdz_user') || localStorage.getItem('user');
      const user = raw ? JSON.parse(raw) : {};
      return String(user.role || user.user_type || '').toLowerCase();
    } catch (_) { return ''; }
  }

  function showCommunityModal(role) {
    if (!role || (role !== 'teacher' && role !== 'student')) return;
    if (sessionStorage.getItem('zoomdz_community_seen') === '1') return;
    sessionStorage.setItem('zoomdz_community_seen', '1');

    const teacher = role === 'teacher';
    const modal = document.createElement('div');
    modal.className = 'zoomdz-community-modal is-open';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'zoomdz-community-title');
    modal.innerHTML = `
      <div class="zoomdz-community-card">
        <div class="zoomdz-community-icon" aria-hidden="true"><i class="fab fa-telegram-plane"></i></div>
        <h2 id="zoomdz-community-title">انضم إلى مجتمع ZoomDZ</h2>
        <p>${teacher ? 'أستاذنا العزيز، انضم إلى مجتمع ZoomDZ حيث مئات الطلبة والأساتذة في انتظارك.' : 'طالبنا العزيز، انضم إلى مجتمع ZoomDZ حيث مئات الدروس والملخصات والأساتذة في انتظارك.'}</p>
        <div class="zoomdz-community-actions">
          <a class="zoomdz-community-join" href="${COMMUNITY_URL}" target="_blank" rel="noopener noreferrer"><i class="fab fa-telegram-plane" aria-hidden="true"></i> الانضمام إلى المجتمع</a>
          <button class="zoomdz-community-close" type="button">لاحقًا</button>
        </div>
      </div>`;
    function close() { modal.remove(); }
    modal.querySelector('.zoomdz-community-close').addEventListener('click', close);
    modal.addEventListener('click', (event) => { if (event.target === modal) close(); });
    document.addEventListener('keydown', function onKey(event) { if (event.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } });
    document.body.appendChild(modal);
  }

  function init() {
    if (!document.getElementById('zoomdz-community-styles')) {
      const style = document.createElement('style');
      style.id = 'zoomdz-community-styles';
      style.textContent = styles;
      document.head.appendChild(style);
    }
    setTimeout(() => showCommunityModal(getRole()), 900);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

window.ZoomDZCommunity = { url: 'https://t.me/ZoomDZ_Group' };
