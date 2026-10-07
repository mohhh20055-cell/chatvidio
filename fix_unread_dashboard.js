const fs = require('fs');

let content = fs.readFileSync('public/student-dashboard.html', 'utf8');

// For student groups: update mapping logic
content = content.replace(
`                                    <div>
                                        <h3 style="margin: 0 0 4px 0; font-size: 1.1rem; color: #0f172a; font-weight: 800;">\${g.name}</h3>`,
`                                    <div style="flex: 1; min-width: 0;">
                                        <h3 style="margin: 0 0 4px 0; font-size: 1.1rem; color: #0f172a; font-weight: 800; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">\${g.name}</h3>`
);

content = content.replace(
`                                        <span style="display: inline-flex; align-items: center; gap: 5px; background: #ecfdf5; color: #059669; padding: 2px 8px; border-radius: 12px; font-size: 0.75rem; font-weight: 700;">
                                            <i class="fas fa-check-circle"></i> عضو منضم
                                        </span>
                                    </div>`,
`                                        <div style="display: flex; gap: 6px;">
                                            <span style="display: inline-flex; align-items: center; gap: 5px; background: #ecfdf5; color: #059669; padding: 2px 8px; border-radius: 12px; font-size: 0.75rem; font-weight: 700;">
                                                <i class="fas fa-check-circle"></i> عضو منضم
                                            </span>
                                            \${g.msg_count ? \`<span style="display: inline-flex; align-items: center; background: #ef4444; color: white; padding: 2px 6px; border-radius: 10px; font-size: 0.7rem; font-weight: 800;">\${g.msg_count > 99 ? '+99' : g.msg_count} رسالة</span>\` : ''}
                                        </div>
                                    </div>`
);

fs.writeFileSync('public/student-dashboard.html', content);

let contentT = fs.readFileSync('public/teacher-dashboard.html', 'utf8');
contentT = contentT.replace(
`                                        <h3 style="margin: 0 0 4px 0; font-size: 1.1rem; color: #0f172a; font-weight: 800;">\${g.name}</h3>
                                        <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
                                            <span style="display: inline-flex; align-items: center; gap: 5px; background: \${g.is_owner ? '#eff6ff' : '#ecfdf5'}; color: \${g.is_owner ? '#2563eb' : '#059669'}; padding: 2px 8px; border-radius: 12px; font-size: 0.75rem; font-weight: 700;">
                                                <i class="fas \${g.is_owner ? 'fa-crown' : 'fa-check-circle'}"></i> \${g.is_owner ? 'المالك' : 'عضو'}
                                            </span>`,
`                                        <h3 style="margin: 0 0 4px 0; font-size: 1.1rem; color: #0f172a; font-weight: 800; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">\${g.name}</h3>
                                        <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
                                            <span style="display: inline-flex; align-items: center; gap: 5px; background: \${g.is_owner ? '#eff6ff' : '#ecfdf5'}; color: \${g.is_owner ? '#2563eb' : '#059669'}; padding: 2px 8px; border-radius: 12px; font-size: 0.75rem; font-weight: 700;">
                                                <i class="fas \${g.is_owner ? 'fa-crown' : 'fa-check-circle'}"></i> \${g.is_owner ? 'المالك' : 'عضو'}
                                            </span>
                                            \${g.msg_count ? \`<span style="display: inline-flex; align-items: center; background: #ef4444; color: white; padding: 2px 6px; border-radius: 10px; font-size: 0.7rem; font-weight: 800;">\${g.msg_count > 99 ? '+99' : g.msg_count} رسالة</span>\` : ''}`
);
fs.writeFileSync('public/teacher-dashboard.html', contentT);
console.log('Fixed dashboards');
