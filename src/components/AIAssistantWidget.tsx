import React, { useState, useEffect, useRef } from 'react';

export default function AIAssistantWidget() {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<{ role: string; content: string }[]>([]);
  const [input, setInput] = useState('');
  const widgetRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x: 20, y: 20 });

  const handleDrag = (e: React.MouseEvent) => {
    // Implement simple drag logic if needed, or stick to fixed position for simplicity
  };

  const sendMessage = async () => {
    if (!input.trim()) return;
    const newMessages = [...messages, { role: 'user', content: input }];
    setMessages(newMessages);
    setInput('');

    try {
      const response = await fetch('/api/ai/platform-assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: input }),
      });
      const data = await response.json();
      setMessages([...newMessages, { role: 'assistant', content: data.message || data.error }]);
    } catch (e) {
      setMessages([...newMessages, { role: 'assistant', content: 'حدث خطأ في الاتصال بالمساعد.' }]);
    }
  };

  return (
    <div
      ref={widgetRef}
      style={{
        position: 'fixed',
        bottom: `${position.y}px`,
        right: `${position.x}px`,
        zIndex: 1000,
      }}
    >
      <div
        onClick={() => setIsOpen(!isOpen)}
        style={{
          width: '60px',
          height: '60px',
          borderRadius: '50%',
          background: 'linear-gradient(135deg, #2563eb, #7c3aed)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'white',
          cursor: 'pointer',
          boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
        }}
      >
        <span style={{ fontSize: '24px' }}>🤖</span>
      </div>

      {isOpen && (
        <div style={{
          position: 'absolute',
          bottom: '80px',
          right: '0',
          width: '300px',
          height: '400px',
          background: 'white',
          borderRadius: '16px',
          boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          padding: '16px',
        }}>
          <div style={{ flex: 1, overflowY: 'auto', marginBottom: '16px' }}>
            {messages.map((m, i) => (
              <div key={i} style={{ marginBottom: '8px', textAlign: m.role === 'user' ? 'right' : 'left' }}>
                <span style={{ background: m.role === 'user' ? '#eff6ff' : '#f1f5f9', padding: '8px', borderRadius: '8px' }}>
                  {m.content}
                </span>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="اسأل عن المنصة..."
              style={{ flex: 1, padding: '8px', borderRadius: '8px', border: '1px solid #e2e8f0' }}
            />
            <button onClick={sendMessage} style={{ padding: '8px 16px', background: '#2563eb', color: 'white', borderRadius: '8px', border: 'none' }}>إرسال</button>
          </div>
        </div>
      )}
    </div>
  );
}
