import re

def fix_inner(filepath):
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    # Find the renderChatMessages function body to replace the assignment
    # We look for:
    #         }
    #         container.innerHTML = html;
    # 
    #         setupLongPressReactions(container);
    # 
    #         if (!silent || isAtBottom) {
    #             container.scrollTop = container.scrollHeight;
    #         }
    #     }

    old_block_teacher = """        }
        container.innerHTML = html;

        setupLongPressReactions(container);

        if (!silent || isAtBottom) {
            container.scrollTop = container.scrollHeight;
        }
    }"""
    
    old_block_student = """        }
        container.innerHTML = html;
        if (!silent && isAtBottom) {
            setTimeout(() => { container.scrollTop = container.scrollHeight; }, 100);
        }
    }"""
    
    # We will just do regex based on "container.innerHTML = html;" until the end of function
    
    new_block = """        }
        
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
        
        if (typeof setupLongPressReactions === 'function') {
            setupLongPressReactions(container);
        }
        
        if (isOlderLoad) {
            const newScrollHeight = container.scrollHeight;
            container.scrollTop = newScrollHeight - previousScrollHeight + previousScrollTop;
        } else if (!silent && (isAtBottom || messages.length <= 20)) {
            setTimeout(() => { container.scrollTop = container.scrollHeight; }, 100);
        }
    }"""

    # We can replace the end of renderChatMessages
    # We will search for container.innerHTML = html; and replace everything to the end of the function block.
    # To be safe, let's just do a string replace of the exact block we found for teacher.
    if old_block_teacher in content:
        content = content.replace(old_block_teacher, new_block)
    else:
        # try regex for student
        content = re.sub(r"container\.innerHTML = html;\s*(setupLongPressReactions\(container\);\s*)?if[^\}]+\}\s*\}", new_block, content)

    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)

fix_inner('public/teacher-dashboard.html')
fix_inner('public/student-dashboard.html')
print("Done")
