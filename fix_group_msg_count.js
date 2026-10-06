const fs = require('fs');

let content = fs.readFileSync('routes/group.js', 'utf8');

// For Teacher
content = content.replace(
`        const latestMsgsMap = {};
        if (groupIds.length > 0) {
            const { data: latestMsgs } = await supabase
                .from('group_messages')
                .select('group_id, created_at')
                .in('group_id', groupIds)
                .order('created_at', { ascending: false });

            if (latestMsgs) {
                latestMsgs.forEach(m => {
                    if (!latestMsgsMap[m.group_id]) {
                        latestMsgsMap[m.group_id] = m.created_at;
                    }
                });
            }
        }`,
`        const latestMsgsMap = {};
        const msgCountsMap = {};
        if (groupIds.length > 0) {
            const { data: latestMsgs } = await supabase
                .from('group_messages')
                .select('group_id, created_at')
                .in('group_id', groupIds)
                .order('created_at', { ascending: false });

            if (latestMsgs) {
                latestMsgs.forEach(m => {
                    msgCountsMap[m.group_id] = (msgCountsMap[m.group_id] || 0) + 1;
                    if (!latestMsgsMap[m.group_id]) {
                        latestMsgsMap[m.group_id] = m.created_at;
                    }
                });
            }
        }`
);

content = content.replace(
`            members_count: groupMembersMap[String(g.id)] ? groupMembersMap[String(g.id)].size : 0,
            latest_message_time: latestMsgsMap[g.id] || null
        }));`,
`            members_count: groupMembersMap[String(g.id)] ? groupMembersMap[String(g.id)].size : 0,
            latest_message_time: latestMsgsMap[g.id] || null,
            msg_count: msgCountsMap[g.id] || 0
        }));`
);

// For Student
content = content.replace(
`        const latestMsgsMap = {};
        if (groupIds.length > 0) {
            const { data: latestMsgs } = await supabase
                .from('group_messages')
                .select('group_id, created_at')
                .in('group_id', groupIds)
                .order('created_at', { ascending: false });

            if (latestMsgs) {
                latestMsgs.forEach(m => {
                    if (!latestMsgsMap[m.group_id]) {
                        latestMsgsMap[m.group_id] = m.created_at;
                    }
                });
            }
        }`,
`        const latestMsgsMap = {};
        const msgCountsMap = {};
        if (groupIds.length > 0) {
            const { data: latestMsgs } = await supabase
                .from('group_messages')
                .select('group_id, created_at')
                .in('group_id', groupIds)
                .order('created_at', { ascending: false });

            if (latestMsgs) {
                latestMsgs.forEach(m => {
                    msgCountsMap[m.group_id] = (msgCountsMap[m.group_id] || 0) + 1;
                    if (!latestMsgsMap[m.group_id]) {
                        latestMsgsMap[m.group_id] = m.created_at;
                    }
                });
            }
        }`
);

content = content.replace(
`        const enriched = activeGroups.map(g => ({
            ...g,
            latest_message_time: latestMsgsMap[g.id] || null
        }));`,
`        const enriched = activeGroups.map(g => ({
            ...g,
            latest_message_time: latestMsgsMap[g.id] || null,
            msg_count: msgCountsMap[g.id] || 0
        }));`
);

fs.writeFileSync('routes/group.js', content);
console.log('Fixed routes/group.js');
