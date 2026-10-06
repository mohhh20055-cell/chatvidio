const fs = require('fs');

let content = fs.readFileSync('public/student-dashboard.html', 'utf8');
content = content.replace(
`                        <div class="conversation-name" style="font-weight:700; color:var(--gray-800); cursor:pointer;" onclick="event.stopPropagation(); \${profileFn}">\${escapeHtml(conv.other_name)}</div>`,
`                        <div class="conversation-name" style="font-weight:700; color:var(--gray-800); cursor:pointer; display:flex; align-items:center; gap:8px;" onclick="event.stopPropagation(); \${profileFn}">
                            \${escapeHtml(conv.other_name)}
                            \${isUnread ? \`<span style="background: #ef4444; color: white; border-radius: 10px; padding: 2px 6px; font-size: 0.65rem; font-weight: 800;">\${conv.unread_count > 99 ? '+99' : conv.unread_count}</span>\` : ''}
                        </div>`
);
fs.writeFileSync('public/student-dashboard.html', content);

let contentT = fs.readFileSync('public/teacher-dashboard.html', 'utf8');
contentT = contentT.replace(
`                        <div class="conversation-name" style="font-weight:700; color:var(--gray-800); cursor:pointer;" onclick="event.stopPropagation(); \${profileFn}">\${escapeHtml(conv.other_name)}</div>`,
`                        <div class="conversation-name" style="font-weight:700; color:var(--gray-800); cursor:pointer; display:flex; align-items:center; gap:8px;" onclick="event.stopPropagation(); \${profileFn}">
                            \${escapeHtml(conv.other_name)}
                            \${isUnread ? \`<span style="background: #ef4444; color: white; border-radius: 10px; padding: 2px 6px; font-size: 0.65rem; font-weight: 800;">\${conv.unread_count > 99 ? '+99' : conv.unread_count}</span>\` : ''}
                        </div>`
);
fs.writeFileSync('public/teacher-dashboard.html', contentT);
console.log('Fixed msg unread badges');
