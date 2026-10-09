import React, { useState, useEffect, useRef } from 'react';
import { 
  Mic, MicOff, Volume2, RotateCcw, Award, BookOpen, 
  Globe, ShieldAlert, Sparkles, CheckCircle2, XCircle, 
  AlertCircle, Lock, Crown, ChevronRight, Play, RefreshCw, Star, History, Calendar, Database, Trash2
} from 'lucide-react';

// Preset texts for English Pronunciation and Arabic Memorization
const ENGLISH_PRESETS = [
  {
    id: 'en-1',
    title: 'Welcome & Platform Introduction',
    text: 'Welcome to ZoomDZ, the ultimate e-learning platform for students across Algeria.',
    translation: 'مرحباً بك في ZoomDZ، منصة التعلم الإلكتروني المثالية للطلاب في جميع أنحاء الجزائر.'
  },
  {
    id: 'en-2',
    title: 'Daily English Practice',
    text: 'Practice makes perfect when learning English pronunciation and mastering speaking skills.',
    translation: 'الممارسة تؤدي إلى الإتقان عند تعلم النطق باللغة الإنجليزية وإتقان مهارات التحدث.'
  },
  {
    id: 'en-3',
    title: 'Inspirational Quote',
    text: 'Education is the most powerful weapon which you can use to change the world.',
    translation: 'التعليم هو السلاح الأقوى الذي يمكنك استخدامه لتغيير العالم.'
  }
];

const ARABIC_PRESETS = [
  {
    id: 'ar-1',
    title: 'تاريخ الجزائر: اندلاع الثورة',
    text: 'اندلعت الثورة الجزائرية الكبرى في أول نوفمبر عام 1954 ضد الاستعمار الفرنسي لتحقيق الاستقلال واسترجاع السيادة الوطنية.',
    category: 'تاريخ'
  },
  {
    id: 'ar-2',
    title: 'جغرافيا الجزائر: التضاريس والمناخ',
    text: 'تتميز الجزائر بتنوع جغرافي كبير يضم شريطاً ساحلياً خصباً وسهولاً عليا داخلية والصحراء الكبرى الشاسعة.',
    category: 'جغرافيا'
  },
  {
    id: 'ar-3',
    title: 'تربية إسلامية: مكارم الأخلاق',
    text: 'قال رسول الله صلى الله عليه وسلم إنما بعثت لأتمم مكارم الأخلاق، وحثنا الدين الإسلامي على الصدق والأمانة وبر الوالدين.',
    category: 'تربية إسلامية'
  }
];

interface PracticeSession {
  id: string;
  mode: 'english' | 'arabic';
  title: string;
  targetText: string;
  transcript: string;
  accuracy: number;
  date: string;
}

export default function App() {
  // State management
  const [activeTab, setActiveTab] = useState<'practice' | 'history' | 'sql'>('practice');
  const [activeMode, setActiveMode] = useState<'english' | 'arabic'>('english');
  const [selectedPresetId, setSelectedPresetId] = useState<string>('en-1');
  const [customText, setCustomText] = useState<string>('');
  const [isCustom, setIsCustom] = useState<boolean>(false);
  
  // Speech & Recognition state
  const [isListening, setIsListening] = useState<boolean>(false);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [transcript, setTranscript] = useState<string>('');
  const [lastResult, setLastResult] = useState<{
    originalWords: string[];
    spokenWords: string[];
    comparison: { word: string; status: 'correct' | 'incorrect' | 'missing'; spoken?: string }[];
    accuracy: number;
  } | null>(null);

  // Practice History state
  const [practiceHistory, setPracticeHistory] = useState<PracticeSession[]>(() => {
    const saved = localStorage.getItem('zoomdz_practice_history');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {
        return [];
      }
    }
    return [
      {
        id: 'hist-1',
        mode: 'english',
        title: 'Welcome & Platform Introduction',
        targetText: 'Welcome to ZoomDZ, the ultimate e-learning platform for students across Algeria.',
        transcript: 'Welcome to ZoomDZ the ultimate e-learning platform for students',
        accuracy: 85,
        date: new Date(Date.now() - 3600000 * 24).toLocaleString('ar-DZ')
      },
      {
        id: 'hist-2',
        mode: 'arabic',
        title: 'تاريخ الجزائر: اندلاع الثورة',
        targetText: 'اندلعت الثورة الجزائرية الكبرى في أول نوفمبر عام 1954 ضد الاستعمار الفرنسي لتحقيق الاستقلال.',
        transcript: 'اندلعت الثورة الجزائرية الكبرى في اول نوفمبر عام 1954 ضد الاستعمار الفرنسي',
        accuracy: 92,
        date: new Date(Date.now() - 3600000 * 5).toLocaleString('ar-DZ')
      }
    ];
  });

  // Attempt counter & Monetization
  const [freeAttempts, setFreeAttempts] = useState<number>(() => {
    const saved = localStorage.getItem('zoomdz_free_attempts');
    return saved ? parseInt(saved, 10) : 0;
  });
  const [isPremium, setIsPremium] = useState<boolean>(() => {
    return localStorage.getItem('zoomdz_is_premium') === 'true';
  });
  const [showPaywallModal, setShowPaywallModal] = useState<boolean>(false);
  const maxFreeAttempts = 3;

  const recognitionRef = useRef<any>(null);

  // Sync with localStorage
  useEffect(() => {
    localStorage.setItem('zoomdz_free_attempts', freeAttempts.toString());
  }, [freeAttempts]);

  useEffect(() => {
    localStorage.setItem('zoomdz_is_premium', isPremium.toString());
  }, [isPremium]);

  useEffect(() => {
    localStorage.setItem('zoomdz_practice_history', JSON.stringify(practiceHistory));
  }, [practiceHistory]);

  // Handle mode switch
  const handleModeChange = (mode: 'english' | 'arabic') => {
    setActiveMode(mode);
    setIsCustom(false);
    setTranscript('');
    setLastResult(null);
    if (mode === 'english') {
      setSelectedPresetId(ENGLISH_PRESETS[0].id);
    } else {
      setSelectedPresetId(ARABIC_PRESETS[0].id);
    }
  };

  // Get current active target text
  const getCurrentTextItem = () => {
    if (isCustom) {
      return {
        id: 'custom',
        title: activeMode === 'english' ? 'Custom English Text' : 'نص مخصص للحفظ',
        text: customText || (activeMode === 'english' ? 'Please enter your custom text here.' : 'الرجاء إدخال النص المخصص هنا.'),
        translation: activeMode === 'english' ? 'Custom practice text.' : undefined,
        category: 'مخصص'
      };
    }
    if (activeMode === 'english') {
      const found = ENGLISH_PRESETS.find(p => p.id === selectedPresetId) || ENGLISH_PRESETS[0];
      return { ...found, category: 'إنجليزية' };
    } else {
      const found = ARABIC_PRESETS.find(p => p.id === selectedPresetId) || ARABIC_PRESETS[0];
      return { ...found, translation: undefined };
    }
  };

  const currentItem = getCurrentTextItem();

  // Strip Arabic diacritics / tashkeel for comparison
  const sanitizeArabic = (text: string) => {
    if (!text) return '';
    return text.replace(/[\u064b-\u0652\u0640]/g, '').trim();
  };

  // Clean and tokenize text for comparison
  const tokenize = (text: string, lang: 'english' | 'arabic') => {
    if (!text) return [];
    let cleaned = text.toLowerCase().replace(/[.,/#!$%^&*;:{}=\-_`~()?"'«»]/g, '');
    if (lang === 'arabic') {
      cleaned = sanitizeArabic(cleaned);
    }
    return cleaned.split(/\s+/).filter(w => w.length > 0);
  };

  // Evaluate speech transcript against target text & save to history
  const evaluateSpeech = (spokenText: string) => {
    setIsProcessing(true);
    setTranscript(spokenText);

    const targetText = currentItem.text;
    const targetWordsRaw = targetText.split(/\s+/);
    const spokenWordsRaw = spokenText.split(/\s+/);

    const targetClean = tokenize(targetText, activeMode === 'english' ? 'english' : 'arabic');
    const spokenClean = tokenize(spokenText, activeMode === 'english' ? 'english' : 'arabic');

    let correctCount = 0;
    const comparison: { word: string; status: 'correct' | 'incorrect' | 'missing'; spoken?: string }[] = [];

    targetWordsRaw.forEach((origWord) => {
      const cleanOrig = tokenize(origWord, activeMode === 'english' ? 'english' : 'arabic')[0] || '';
      if (!cleanOrig) return;

      if (spokenClean.includes(cleanOrig)) {
        correctCount++;
        comparison.push({ word: origWord, status: 'correct' });
      } else {
        comparison.push({ word: origWord, status: 'incorrect' });
      }
    });

    const accuracy = targetClean.length > 0 ? Math.round((correctCount / targetClean.length) * 100) : 0;
    const finalAccuracy = Math.min(100, Math.max(0, accuracy));

    setTimeout(() => {
      setLastResult({
        originalWords: targetWordsRaw,
        spokenWords: spokenWordsRaw,
        comparison,
        accuracy: finalAccuracy
      });
      setIsProcessing(false);

      // Save session to history
      const newSession: PracticeSession = {
        id: 'sess-' + Date.now(),
        mode: activeMode,
        title: currentItem.title,
        targetText: currentItem.text,
        transcript: spokenText,
        accuracy: finalAccuracy,
        date: new Date().toLocaleString('ar-DZ')
      };

      setPracticeHistory(prev => [newSession, ...prev]);
    }, 400);
  };

  // Start Web Speech Recognition
  const startListening = () => {
    if (!isPremium && freeAttempts >= maxFreeAttempts) {
      setShowPaywallModal(true);
      return;
    }

    if (!isPremium) {
      setFreeAttempts(prev => prev + 1);
    }

    const SpeechRecognitionAPI = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognitionAPI) {
      alert('عذراً، متصفحك لا يدعم خاصية التعرف على الصوت. يرجى استخدام متصفح Google Chrome.');
      return;
    }

    try {
      const recognition = new SpeechRecognitionAPI();
      recognitionRef.current = recognition;
      recognition.lang = activeMode === 'english' ? 'en-US' : 'ar-SA';
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;

      setIsListening(true);
      setTranscript('');

      recognition.onresult = (event: any) => {
        const speechResult = event.results[0][0].transcript;
        setIsListening(false);
        evaluateSpeech(speechResult);
      };

      recognition.onerror = (event: any) => {
        console.error('Speech recognition error', event.error);
        setIsListening(false);
        setIsProcessing(false);
      };

      recognition.onend = () => {
        setIsListening(false);
      };

      recognition.start();
    } catch (err) {
      console.error(err);
      setIsListening(false);
      setIsProcessing(false);
    }
  };

  const stopListening = () => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
    }
    setIsListening(false);
  };

  // Text-To-Speech for correcting incorrect words
  const speakWord = (word: string) => {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(word);
    utterance.lang = activeMode === 'english' ? 'en-US' : 'ar-SA';
    utterance.rate = 0.9;
    window.speechSynthesis.speak(utterance);
  };

  const speakFullText = () => {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(currentItem.text);
    utterance.lang = activeMode === 'english' ? 'en-US' : 'ar-SA';
    window.speechSynthesis.speak(utterance);
  };

  const clearHistory = () => {
    if (window.confirm('هل أنت متأكد من مسح جميع سجلات الجلسات السابقة؟')) {
      setPracticeHistory([]);
      localStorage.removeItem('zoomdz_practice_history');
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans antialiased flex flex-col selection:bg-indigo-500 selection:text-white" dir="rtl">
      
      {/* Top Navigation Bar adhering to Strict 3-Zone Contract */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-40 shadow-xs">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-8">
          
          {/* Zone 1: Brand Wordmark */}
          <div className="flex items-center gap-3 whitespace-nowrap shrink-0">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-indigo-600 to-violet-600 flex items-center justify-center text-white font-bold shadow-md shadow-indigo-200">
              DZ
            </div>
            <div>
              <span className="text-lg font-bold tracking-tight text-slate-900 block leading-none">ZoomDZ</span>
              <span className="text-[11px] font-medium text-indigo-600 block mt-1">Smart Memorization & Pronunciation</span>
            </div>
          </div>

          {/* Zone 2: Navigation Links */}
          <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600">
            <button 
              onClick={() => setActiveTab('practice')} 
              className={`transition-colors whitespace-nowrap shrink-0 pb-1 border-b-2 ${activeTab === 'practice' ? 'border-indigo-600 text-indigo-600 font-semibold' : 'border-transparent hover:text-slate-900'}`}
            >
              منصة التدريب النطقي والحفظ
            </button>
            <button 
              onClick={() => setActiveTab('history')} 
              className={`transition-colors whitespace-nowrap shrink-0 pb-1 border-b-2 ${activeTab === 'history' ? 'border-indigo-600 text-indigo-600 font-semibold' : 'border-transparent hover:text-slate-900'}`}
            >
              سجل الجلسات السابقة ({practiceHistory.length})
            </button>
            <button 
              onClick={() => setActiveTab('sql')} 
              className={`transition-colors whitespace-nowrap shrink-0 pb-1 border-b-2 ${activeTab === 'sql' ? 'border-indigo-600 text-indigo-600 font-semibold' : 'border-transparent hover:text-slate-900'}`}
            >
              كود قاعدة البيانات SQL
            </button>
          </nav>

          {/* Zone 3: Primary Action & Counter */}
          <div className="flex items-center gap-3 shrink-0">
            <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 bg-slate-100 rounded-full text-xs font-medium text-slate-700">
              <Sparkles className="w-3.5 h-3.5 text-indigo-600" />
              <span>المحاولات: {freeAttempts}/{maxFreeAttempts}</span>
            </div>

            {isPremium ? (
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-amber-50 text-amber-800 border border-amber-200 rounded-lg text-xs font-semibold shadow-xs">
                <Crown className="w-4 h-4 text-amber-600" />
                ZoomDZ Premium
              </span>
            ) : (
              <button 
                onClick={() => setShowPaywallModal(true)}
                className="px-4 py-2 text-xs font-semibold text-white bg-gradient-to-r from-indigo-600 to-violet-600 rounded-lg hover:from-indigo-700 hover:to-violet-700 transition-all shadow-sm whitespace-nowrap shrink-0 flex items-center gap-1.5"
              >
                <Crown className="w-3.5 h-3.5" />
                ترقية الحساب
              </button>
            )}
          </div>

        </div>
      </header>

      {/* Mobile Navigation Bar */}
      <div className="flex md:hidden bg-white border-b border-slate-200 px-4 py-2 justify-around text-xs font-medium text-slate-700">
        <button onClick={() => setActiveTab('practice')} className={`pb-1 ${activeTab === 'practice' ? 'text-indigo-600 font-bold border-b-2 border-indigo-600' : ''}`}>التدريب</button>
        <button onClick={() => setActiveTab('history')} className={`pb-1 ${activeTab === 'history' ? 'text-indigo-600 font-bold border-b-2 border-indigo-600' : ''}`}>السجل ({practiceHistory.length})</button>
        <button onClick={() => setActiveTab('sql')} className={`pb-1 ${activeTab === 'sql' ? 'text-indigo-600 font-bold border-b-2 border-indigo-600' : ''}`}>قاعدة البيانات SQL</button>
      </div>

      {/* Main Container / Content */}
      <main className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8 flex-1 w-full">
        
        {activeTab === 'practice' && (
          <>
            {/* Mode Selector */}
            <div className="flex items-center justify-center gap-3 mb-6 bg-white p-1.5 rounded-xl border border-slate-200 shadow-xs max-w-md mx-auto">
              <button
                onClick={() => handleModeChange('english')}
                className={`flex-1 py-2 text-xs font-semibold rounded-lg transition-colors ${activeMode === 'english' ? 'bg-indigo-600 text-white' : 'text-slate-600'}`}
              >
                English Pronunciation Mode
              </button>
              <button
                onClick={() => handleModeChange('arabic')}
                className={`flex-1 py-2 text-xs font-semibold rounded-lg transition-colors ${activeMode === 'arabic' ? 'bg-indigo-600 text-white' : 'text-slate-600'}`}
              >
                وضع الحفظ العربي
              </button>
            </div>

            {/* Hero Section / Banner */}
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 sm:p-8 mb-8 relative overflow-hidden">
              <div className="absolute top-0 left-0 w-32 h-32 bg-indigo-50 rounded-full blur-2xl pointer-events-none -translate-x-10 -translate-y-10"></div>
              
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="px-2.5 py-1 bg-indigo-50 text-indigo-700 rounded-md text-xs font-semibold">
                      {activeMode === 'english' ? 'وضع النطق الصوتي' : `وضع الحفظ (${currentItem.category || 'عام'})`}
                    </span>
                    <span className="text-xs text-slate-400">·</span>
                    <span className="text-xs text-slate-500 font-medium">يتم حفظ الجلسات في سجل الطالب تلقائياً</span>
                  </div>
                  <h1 className="text-xl sm:text-2xl font-bold text-slate-900 tracking-tight">
                    {activeMode === 'english' ? 'Smart English Pronunciation Trainer' : 'المحفظ الذكي وتصحيح التلاوة والنصوص'}
                  </h1>
                </div>

                <button
                  onClick={speakFullText}
                  className="self-start sm:self-auto inline-flex items-center gap-2 px-3.5 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-semibold transition-colors"
                  title="استماع للنص كاملاً"
                >
                  <Volume2 className="w-4 h-4 text-indigo-600" />
                  <span>استماع للنص</span>
                </button>
              </div>

              {/* Preset Selector */}
              <div className="space-y-3 mb-6">
                <label className="block text-xs font-semibold text-slate-600">اختر نصاً للتمرن عليه:</label>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {(activeMode === 'english' ? ENGLISH_PRESETS : ARABIC_PRESETS).map((item) => (
                    <button
                      key={item.id}
                      onClick={() => { setSelectedPresetId(item.id); setIsCustom(false); setLastResult(null); setTranscript(''); }}
                      className={`text-right p-3.5 rounded-xl border transition-all text-xs flex flex-col justify-between ${!isCustom && selectedPresetId === item.id ? 'border-indigo-600 bg-indigo-50/50 ring-2 ring-indigo-600/10' : 'border-slate-200 bg-white hover:border-slate-300'}`}
                    >
                      <span className="font-bold text-slate-900 mb-1 line-clamp-1">{item.title}</span>
                      <span className="text-slate-500 line-clamp-2" dir={activeMode === 'english' ? 'ltr' : 'rtl'}>{item.text}</span>
                    </button>
                  ))}
                </div>

                {/* Custom Text Toggle / Input */}
                <div className="pt-2">
                  {!isCustom ? (
                    <button
                      onClick={() => { setIsCustom(true); setLastResult(null); setTranscript(''); }}
                      className="text-xs font-semibold text-indigo-600 hover:text-indigo-700 inline-flex items-center gap-1"
                    >
                      + إدخال نص مخصص للتمرن
                    </button>
                  ) : (
                    <div className="space-y-2 bg-slate-50 p-4 rounded-xl border border-slate-200">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-slate-700">النص المخصص:</span>
                        <button
                          onClick={() => setIsCustom(false)}
                          className="text-xs text-rose-600 hover:text-rose-700 font-medium"
                        >
                          العودة للنصوص الجاهزة
                        </button>
                      </div>
                      <textarea
                        value={customText}
                        onChange={(e) => setCustomText(e.target.value)}
                        placeholder={activeMode === 'english' ? 'Enter English sentence here...' : 'اكتب النص العربي هنا للحفظ والتصحيح...'}
                        className="w-full p-3 bg-white border border-slate-300 rounded-lg text-sm focus:outline-hidden focus:ring-2 focus:ring-indigo-600/20 focus:border-indigo-600 resize-none h-20"
                        dir={activeMode === 'english' ? 'ltr' : 'rtl'}
                      />
                    </div>
                  )}
                </div>
              </div>

              {/* Target Text Display Box */}
              <div className="bg-slate-900 text-white rounded-xl p-6 shadow-inner relative">
                <div className="text-[11px] font-medium text-indigo-400 mb-1 uppercase tracking-wider">
                  {activeMode === 'english' ? 'Target English Sentence' : 'النص المطلوب حفظه'}
                </div>
                <p className="text-lg sm:text-xl font-semibold leading-relaxed" dir={activeMode === 'english' ? 'ltr' : 'rtl'}>
                  {currentItem.text}
                </p>
                {activeMode === 'english' && 'translation' in currentItem && currentItem.translation && (
                  <div className="mt-3 pt-3 border-t border-slate-800 text-slate-300 text-sm">
                    <span className="text-xs text-slate-400 block mb-0.5">الترجمة العربية:</span>
                    {currentItem.translation}
                  </div>
                )}
              </div>
            </div>

            {/* Recording & Interaction Stage */}
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 sm:p-8 mb-8 text-center">
              <h2 className="text-base font-bold text-slate-900 mb-2">
                {isListening ? 'جاري الاستماع... انطق النص الآن' : isProcessing ? 'جاري تحليل نطقك ومقارنة الكلمات وحفظ الجلسة...' : 'اضغط على الزر وابدأ القراءة بصوت عالٍ'}
              </h2>
              <p className="text-xs text-slate-500 mb-6">
                {activeMode === 'english' ? 'سيقوم النظام بالاستماع باللغة الإنجليزية (en-US)' : 'سيقوم النظام بالاستماع باللغة العربية (ar-SA) وتجاهل التشكيل'}
              </p>

              {/* Microphone Action Button */}
              <div className="flex flex-col items-center justify-center gap-4">
                {!isListening ? (
                  <button
                    onClick={startListening}
                    disabled={isProcessing}
                    className="w-20 h-20 rounded-full bg-indigo-600 hover:bg-indigo-700 active:scale-95 text-white flex items-center justify-center shadow-lg shadow-indigo-600/30 transition-all cursor-pointer disabled:opacity-50"
                  >
                    <Mic className="w-8 h-8 animate-pulse" />
                  </button>
                ) : (
                  <button
                    onClick={stopListening}
                    className="w-20 h-20 rounded-full bg-rose-600 hover:bg-rose-700 text-white flex items-center justify-center shadow-lg shadow-rose-600/30 transition-all animate-bounce cursor-pointer"
                  >
                    <MicOff className="w-8 h-8" />
                  </button>
                )}

                <span className="text-xs font-semibold text-slate-600">
                  {isListening ? 'اضغط للإيقاف' : 'اضغط للبدء بالتسجيل'}
                </span>
              </div>

              {/* Live Transcript / Feedback */}
              {transcript && (
                <div className="mt-6 p-4 bg-slate-50 rounded-xl border border-slate-200 text-right">
                  <div className="text-xs font-semibold text-slate-500 mb-1">ما تم التقاطه صوتياً:</div>
                  <p className="text-sm font-medium text-slate-800" dir={activeMode === 'english' ? 'ltr' : 'rtl'}>
                    "{transcript}"
                  </p>
                </div>
              )}
            </div>

            {/* Word-by-Word Comparison Results */}
            {lastResult && (
              <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 sm:p-8 animate-fade-in">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6 pb-4 border-b border-slate-100">
                  <div>
                    <h3 className="text-lg font-bold text-slate-900">نتيجة التحليل وحفظ الجلسة</h3>
                    <p className="text-xs text-slate-500">اضغط على أي كلمة باللون الأحمر لسماع النطق الصحيح. تم حفظ هذه الجلسة في سجلك.</p>
                  </div>

                  <div className="flex items-center gap-3">
                    <div className={`px-4 py-2 rounded-xl text-sm font-bold flex items-center gap-2 ${lastResult.accuracy >= 80 ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : lastResult.accuracy >= 50 ? 'bg-amber-50 text-amber-700 border border-amber-200' : 'bg-rose-50 text-rose-700 border border-rose-200'}`}>
                      <span>دقة النطق: {lastResult.accuracy}%</span>
                    </div>
                  </div>
                </div>

                {/* Rendered Words with Color Coding */}
                <div className="mb-6">
                  <div className="text-xs font-semibold text-slate-500 mb-3">مقارنة كلمة بكلمة (الأخضر: صحيح، الأحمر: خطأ أو مفقود):</div>
                  <div className="flex flex-wrap gap-2 text-base sm:text-lg p-4 bg-slate-50 rounded-xl border border-slate-200 leading-loose" dir={activeMode === 'english' ? 'ltr' : 'rtl'}>
                    {lastResult.comparison.map((item, idx) => {
                      if (item.status === 'correct') {
                        return (
                          <span key={idx} className="px-2.5 py-1 bg-emerald-100 text-emerald-800 rounded-lg font-medium border border-emerald-300 shadow-2xs">
                            {item.word}
                          </span>
                        );
                      } else {
                        return (
                          <span
                            key={idx}
                            onClick={() => speakWord(item.word)}
                            className="px-2.5 py-1 bg-rose-100 text-rose-800 rounded-lg font-medium border border-rose-300 line-through cursor-pointer hover:bg-rose-200 transition-colors shadow-2xs group relative"
                            title="انقر للاستماع للنطق الصحيح"
                          >
                            {item.word}
                            <span className="absolute -bottom-6 left-1/2 -translate-x-1/2 bg-slate-900 text-white text-[10px] px-1.5 py-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none">
                              استماع للنطق الصحيح
                            </span>
                          </span>
                        );
                      }
                    })}
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-4 text-xs text-slate-500 pt-4 border-t border-slate-100">
                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-1.5">
                      <span className="w-3 h-3 rounded-full bg-emerald-500 inline-block"></span>
                      <span>كلمة صحيحة</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="w-3 h-3 rounded-full bg-rose-500 inline-block"></span>
                      <span>كلمة خاطئة أو مفقودة (انقر للاستماع)</span>
                    </div>
                  </div>

                  <button
                    onClick={() => startListening()}
                    className="inline-flex items-center gap-1.5 font-semibold text-indigo-600 hover:text-indigo-700"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>إعادة المحاولة</span>
                  </button>
                </div>
              </div>
            )}
          </>
        )}

        {/* History Tab */}
        {activeTab === 'history' && (
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 sm:p-8">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6 pb-4 border-b border-slate-100">
              <div>
                <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
                  <History className="w-5 h-5 text-indigo-600" />
                  <span>سجل الجلسات السابقة للطالب</span>
                </h2>
                <p className="text-xs text-slate-500 mt-1">عرض جميع جلسات القراءة والحفظ السابقة مع نسبة الدقة والنصوص المنطوقة.</p>
              </div>

              {practiceHistory.length > 0 && (
                <button
                  onClick={clearHistory}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-rose-50 hover:bg-rose-100 text-rose-700 rounded-xl text-xs font-semibold transition-colors self-start"
                >
                  <Trash2 className="w-4 h-4" />
                  <span>مسح السجل</span>
                </button>
              )}
            </div>

            {practiceHistory.length === 0 ? (
              <div className="text-center py-12">
                <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-4 text-slate-400">
                  <History className="w-8 h-8" />
                </div>
                <h3 className="text-base font-bold text-slate-800 mb-1">لا توجد جلسات مسجلة بعد</h3>
                <p className="text-xs text-slate-500 mb-4">قم بإجراء اختبار نطق أو حفظ وسيتم حفظ سجلك هنا تلقائياً.</p>
                <button
                  onClick={() => setActiveTab('practice')}
                  className="px-4 py-2 bg-indigo-600 text-white rounded-xl text-xs font-semibold hover:bg-indigo-700 transition-colors"
                >
                  ابدأ التدريب الآن
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                {practiceHistory.map((session) => (
                  <div key={session.id} className="p-4 sm:p-5 rounded-xl border border-slate-200 bg-slate-50 hover:border-indigo-200 transition-all">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3">
                      <div className="flex items-center gap-2">
                        <span className={`px-2.5 py-0.5 rounded text-[11px] font-semibold ${session.mode === 'english' ? 'bg-indigo-100 text-indigo-800' : 'bg-emerald-100 text-emerald-800'}`}>
                          {session.mode === 'english' ? 'English Pronunciation' : 'حفظ عربي'}
                        </span>
                        <span className="font-bold text-slate-900 text-sm">{session.title}</span>
                      </div>

                      <div className="flex items-center gap-3">
                        <span className="text-xs text-slate-500 flex items-center gap-1">
                          <Calendar className="w-3.5 h-3.5" />
                          {session.date}
                        </span>
                        <span className={`px-3 py-1 rounded-lg text-xs font-bold ${session.accuracy >= 80 ? 'bg-emerald-100 text-emerald-800' : session.accuracy >= 50 ? 'bg-amber-100 text-amber-800' : 'bg-rose-100 text-rose-800'}`}>
                          الدقة: {session.accuracy}%
                        </span>
                      </div>
                    </div>

                    <div className="space-y-2 text-xs">
                      <div className="p-3 bg-white rounded-lg border border-slate-200">
                        <span className="font-semibold text-slate-500 block mb-0.5">النص الأصلي المطلوب:</span>
                        <p className="text-slate-800 font-medium" dir={session.mode === 'english' ? 'ltr' : 'rtl'}>{session.targetText}</p>
                      </div>

                      <div className="p-3 bg-white rounded-lg border border-slate-200">
                        <span className="font-semibold text-slate-500 block mb-0.5">ما قراه ونطقه الطالب:</span>
                        <p className="text-indigo-900 font-medium" dir={session.mode === 'english' ? 'ltr' : 'rtl'}>"{session.transcript}"</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* SQL Schema Tab */}
        {activeTab === 'sql' && (
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 sm:p-8">
            <div className="mb-6 pb-4 border-b border-slate-100">
              <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
                <Database className="w-5 h-5 text-indigo-600" />
                <span>كود قاعدة البيانات SQL (حفظ الجلسات)</span>
              </h2>
              <p className="text-xs text-slate-500 mt-1">استخدم كود SQL التالي لإنشاء جدول جلسات التدريب في قاعدة بيانات PostgreSQL / Supabase الخاصة بمنصة ZoomDZ.</p>
            </div>

            <div className="relative">
              <pre className="p-4 bg-slate-900 text-indigo-200 rounded-xl text-xs overflow-x-auto font-mono leading-relaxed" dir="ltr">
{`-- =========================================================================
-- ZoomDZ Platform - Student Practice Sessions SQL Schema
-- Stores student pronunciation and memorization practice history
-- =========================================================================

CREATE TABLE IF NOT EXISTS student_practice_sessions (
    id SERIAL PRIMARY KEY,
    student_id VARCHAR(255) DEFAULT 'guest',
    mode VARCHAR(50) NOT NULL, -- 'english' or 'arabic'
    title VARCHAR(255) NOT NULL,
    target_text TEXT NOT NULL,
    spoken_transcript TEXT,
    accuracy INT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create index for performance optimization when querying student sessions
CREATE INDEX IF NOT EXISTS idx_student_practice_sessions_student_id ON student_practice_sessions(student_id);
CREATE INDEX IF NOT EXISTS idx_student_practice_sessions_created_at ON student_practice_sessions(created_at DESC);`}
              </pre>
            </div>

            <div className="mt-4 p-4 bg-indigo-50 border border-indigo-100 rounded-xl text-xs text-indigo-900 leading-relaxed">
              <span className="font-bold block mb-1">ملاحظة تقنية:</span>
              هذا الجدول يتيح حفظ معرف الطالب (`student_id`)، وضع التدريب (`mode`)، عنوان النص، النص الأصلي، النص المنطوق، ونسبة الدقة لكل جلسة مع طابع زمني دقيق (`created_at`).
            </div>
          </div>
        )}

      </main>

      {/* Footer */}
      <footer className="bg-white border-t border-slate-200 py-6 mt-12 text-center text-xs text-slate-500">
        <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-4">
          <p>© 2026 ZoomDZ E-Learning Platform. جميع الحقوق محفوظة.</p>
          <div className="flex items-center gap-4">
            <span>مدعوم بسجل جلسات الطالب الذكي وقاعدة بيانات SQL</span>
          </div>
        </div>
      </footer>

      {/* Paywall Modal for Free Attempt Counter */}
      {showPaywallModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 animate-fade-in">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 sm:p-8 shadow-xl border border-slate-200 text-center relative overflow-hidden">
            <div className="absolute top-0 right-0 w-40 h-40 bg-amber-50 rounded-full blur-3xl pointer-events-none -translate-y-10 translate-x-10"></div>
            
            <div className="w-16 h-16 rounded-2xl bg-amber-100 text-amber-600 flex items-center justify-center mx-auto mb-4 shadow-md shadow-amber-100">
              <Crown className="w-8 h-8" />
            </div>

            <h3 className="text-xl font-bold text-slate-900 mb-2">
              انتهت محاولاتك المجانية اليومية!
            </h3>
            <p className="text-sm text-slate-600 mb-6 leading-relaxed">
              لقد استخدمت {maxFreeAttempts} من {maxFreeAttempts} محاولات مجانية متاحة اليوم. قم بالترقية إلى <span className="font-semibold text-indigo-600">ZoomDZ Premium</span> للاستمتاع بتصحيح غير محدود وحفظ عدد غير محدود من الجلسات.
            </p>

            <div className="space-y-3">
              <button
                onClick={() => {
                  setIsPremium(true);
                  setShowPaywallModal(false);
                  setFreeAttempts(0);
                }}
                className="w-full py-3 bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-700 hover:to-violet-700 text-white font-semibold rounded-xl text-sm shadow-md shadow-indigo-600/25 transition-all"
              >
                فتح التدريب غير المحدود الآن (تجريبي)
              </button>
              <button
                onClick={() => setShowPaywallModal(false)}
                className="w-full py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold rounded-xl text-xs transition-colors"
              >
                لاحقاً
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
