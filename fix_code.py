import re

def fix_file(filepath, is_teacher):
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    is_teacher_str = "${teacherId}/teacher" if is_teacher else "${studentId}/student"
    catch_str = "if (e.message !== 'انتهت صلاحية الجلسة') { console.log(e); if (container) container.innerHTML = '<p style=\"text-align:center; padding:20px; color:var(--danger);\">حدث خطأ في تحميل الرسائل</p>'; }" if not is_teacher else "if (e.message !== 'انتهت صلاحية الجلسة') { console.log(e); container.innerHTML = '<p style=\"text-align:center; padding:20px; color:var(--danger);\">حدث خطأ في تحميل الرسائل</p>'; }"

    new_load = """
    let directChatLimit = 20;
    let directChatHasMore = true;
    let directChatIsLoadingOlder = false;
    let activeDirectChatOtherId = null;
    let activeDirectChatOtherType = null;

    async function loadConversationMessages(otherId, otherType = 'teacher', silent = false, isOlderLoad = false) {
        const container = document.getElementById('chatMessages');
        if (!container) return;

        if (!container._paginationAttached) {
            container._paginationAttached = true;
            let scrollDebounce = null;
            container.addEventListener('scroll', () => {
                if (scrollDebounce) clearTimeout(scrollDebounce);
                scrollDebounce = setTimeout(() => {
                    if (container.scrollTop <= 60 && directChatHasMore && !directChatIsLoadingOlder) {
                        loadConversationMessages(activeDirectChatOtherId, activeDirectChatOtherType, false, true);
                    }
                }, 100);
            }, { passive: true });
        }

        if (isOlderLoad) {
            if (directChatIsLoadingOlder || !directChatHasMore) return;
            directChatIsLoadingOlder = true;
            directChatLimit += 20;
        } else {
            directChatLimit = 20;
            directChatHasMore = true;
            directChatIsLoadingOlder = false;
            activeDirectChatOtherId = otherId;
            activeDirectChatOtherType = otherType;
            if (!silent) {
                container.innerHTML = '<div class="loading" style="text-align:center; padding:20px; color:var(--gray-400);"><i class="fas fa-spinner fa-spin"></i> جاري التحميل...</div>';
            }
        }

        const previousScrollHeight = container.scrollHeight;
        const previousScrollTop = container.scrollTop;

        try {
            const typeParam = otherType || (currentChatTeacher ? currentChatTeacher.type : 'teacher');
            const res = await fetchWithAuth(`/api/messages/""" + is_teacher_str + """/${otherId}/${typeParam}?limit=${directChatLimit}`);
            const messages = await res.json();
            
            if (!Array.isArray(messages) || messages.length < directChatLimit) {
                directChatHasMore = false;
            }
            
            renderChatMessages(messages, silent, isOlderLoad, previousScrollHeight, previousScrollTop);
            checkUnreadMessagesCount();
        } catch(e) { 
            """ + catch_str + """ 
        } finally {
            if (isOlderLoad) {
                setTimeout(() => { directChatIsLoadingOlder = false; }, 300);
            }
        }
    }"""

    load_regex = re.compile(r"async function loadConversationMessages\([^)]+\)\s*\{[\s\S]*?renderChatMessages[^\}]+\}[\s\S]*?(?=\n\s*(let currentChatReply|function renderChatMessages))")
    content = load_regex.sub(new_load + "\n\n    ", content)

    render_regex = re.compile(r"function renderChatMessages\(messages, silent = false\) \{")
    content = render_regex.sub("function renderChatMessages(messages, silent = false, isOlderLoad = false, previousScrollHeight = 0, previousScrollTop = 0) {", content)

    inner_html_regex = re.compile(r"container\.innerHTML = html;\s*(if \(!silent && isAtBottom\)\s*\{\s*setTimeout[^\}]+\}\s*)")
    
    new_inner = """
        let topBannerHtml = '';
        if (directChatHasMore && messages && messages.length >= 20) {
            topBannerHtml = `
                <div style="text-align: center; margin-bottom: 12px;">
                    <button type="button" onclick="loadConversationMessages(activeDirectChatOtherId, activeDirectChatOtherType, false, true)" style="background: #ffffff; border: 1px solid #cbd5e1; border-radius: 20px; padding: 6px 16px; font-size: 0.78rem; font-weight: 700; color: #475569; cursor: pointer; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
                        <i class="fas fa-arrow-up" style="color: var(--primary, #3b82f6);"></i> تحميل 20 رسالة أقدم
                    </button>
                </div>
            `;
        }
        
        container.innerHTML = topBannerHtml + html;
        
        if (isOlderLoad) {
            const newScrollHeight = container.scrollHeight;
            container.scrollTop = newScrollHeight - previousScrollHeight + previousScrollTop;
        } else if (!silent && (isAtBottom || messages.length <= 20)) {
            setTimeout(() => { container.scrollTop = container.scrollHeight; }, 100);
        }
        """
    content = inner_html_regex.sub(new_inner, content)

    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)

fix_file('public/teacher-dashboard.html', True)
fix_file('public/student-dashboard.html', False)

print("Done")
