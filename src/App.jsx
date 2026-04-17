import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Model Options per Provider
const MODEL_OPTIONS = {
  gemini: {
    label: 'Gemini',
    models: [
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
      { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' },
    ],
  },
  claude: {
    label: 'Claude',
    models: [
      { id: 'claude-opus-4-7', name: 'Claude Opus 4.7' },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
    ],
  },
  openai: {
    label: 'OpenAI',
    models: [
      { id: 'gpt-4o', name: 'GPT-4o' },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
    ],
  },
};

// --- API Helpers via Serverless Proxy ---
async function fetchChat(provider, model, messages, system) {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, system, provider, model }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || `API Error: ${response.status}`);
  }
  const data = await response.json();
  return data.text;
}

async function fetchStream(provider, model, messages, system, onChunk) {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, system, provider, model, stream: true }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || `API Error: ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (line.startsWith('data: [DONE]')) continue;
      if (line.startsWith('data: ')) {
        try {
          const parsed = JSON.parse(line.slice(6));
          if (parsed.error) throw new Error(parsed.error);
          if (parsed.text) {
            fullText += parsed.text;
            onChunk(fullText);
          }
        } catch (e) {
          if (e.message && !e.message.includes('Unexpected')) throw e;
        }
      }
    }
  }
  return fullText;
}
import * as XLSX from 'xlsx';
import * as pdfjsLib from 'pdfjs-dist';
import mammoth from 'mammoth';
import html2canvas from 'html2canvas';
import jsPDF from 'jspdf';
import { EXPERT_PRESETS, PRESET_DESCRIPTIONS, DEFAULT_EXPERT, formatExpertDisplay } from './presets/expertPresets';
import './index.css';

// PDF.js worker configuration
pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;

function App() {
  // Project State
  const [projects, setProjects] = useState(() => {
    const saved = localStorage.getItem('context_chat_projects');
    if (!saved) return [];
    try { return JSON.parse(saved); } catch { return []; }
  });
  const [currentProjectId, setCurrentProjectId] = useState(() => {
    return localStorage.getItem('context_chat_current_project') || null;
  });
  const [showProjectManager, setShowProjectManager] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');

  // Data State
  const [items, setItems] = useState([]);
  const [uploadedFiles, setUploadedFiles] = useState([]); // Track uploaded files
  const [selectedItems, setSelectedItems] = useState([]);
  const [dataSchema, setDataSchema] = useState([]);
  const [dataName, setDataName] = useState('');

  // Input Mode
  const [inputMode, setInputMode] = useState('text'); // text, file, url
  const [textInput, setTextInput] = useState('');
  const [urlInput, setUrlInput] = useState('');
  const [isFetchingUrl, setIsFetchingUrl] = useState(false);
  const [isParsingFile, setIsParsingFile] = useState(false);

  // API & Model (keys managed server-side)
  const [showSettings, setShowSettings] = useState(false);
  const [provider, setProvider] = useState(localStorage.getItem('context_chat_provider') || 'gemini');
  const [selectedModel, setSelectedModel] = useState(localStorage.getItem('context_chat_model') || 'gemini-2.5-flash');
  const handleSaveProvider = (p) => {
    setProvider(p);
    localStorage.setItem('context_chat_provider', p);
    const defaultModel = MODEL_OPTIONS[p].models[1]?.id || MODEL_OPTIONS[p].models[0].id;
    setSelectedModel(defaultModel);
    localStorage.setItem('context_chat_model', defaultModel);
  };
  const handleSaveModel = (m) => {
    setSelectedModel(m);
    localStorage.setItem('context_chat_model', m);
  };

  // Chat State
  const [chatInput, setChatInput] = useState('');
  const [chatHistory, setChatHistory] = useState([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isDiscussing, setIsDiscussing] = useState(false);
  const chatEndRef = useRef(null);

  // Expert State
  const [selectedPreset, setSelectedPreset] = useState('education');
  const [experts, setExperts] = useState(() => {
    const saved = localStorage.getItem('context_chat_experts');
    if (!saved) return EXPERT_PRESETS.education;
    try { return JSON.parse(saved); } catch { return EXPERT_PRESETS.education; }
  });
  const [selectedExperts, setSelectedExperts] = useState(() => {
    const saved = localStorage.getItem('context_chat_selected_experts');
    if (!saved) return ['curriculum', 'teacher', 'evaluator'];
    try { return JSON.parse(saved); } catch { return ['curriculum', 'teacher', 'evaluator']; }
  });
  const [discussionRounds, setDiscussionRounds] = useState(2);
  const [showExpertEditor, setShowExpertEditor] = useState(false);

  // Session Storage
  const [savedSessions, setSavedSessions] = useState(() => {
    const saved = localStorage.getItem('context_chat_sessions');
    if (!saved) return [];
    try { return JSON.parse(saved); } catch { return []; }
  });
  const [showSessionManager, setShowSessionManager] = useState(false);

  // Expert Rating & Memory
  const [expertRatings, setExpertRatings] = useState(() => {
    const saved = localStorage.getItem('context_chat_expert_ratings');
    if (!saved) return {};
    try { return JSON.parse(saved); } catch { return {}; }
  });
  const [expertMemory, setExpertMemory] = useState(() => {
    const saved = localStorage.getItem('context_chat_expert_memory');
    if (!saved) return {};
    try { return JSON.parse(saved); } catch { return {}; }
  });

  // Get current project
  const currentProject = projects.find(p => p.id === currentProjectId);

  // Save projects to localStorage
  useEffect(() => {
    localStorage.setItem('context_chat_projects', JSON.stringify(projects));
  }, [projects]);

  useEffect(() => {
    if (currentProjectId) {
      localStorage.setItem('context_chat_current_project', currentProjectId);
    }
  }, [currentProjectId]);

  // Load project data when switching projects
  useEffect(() => {
    if (currentProject) {
      setItems(currentProject.items || []);
      setUploadedFiles(currentProject.uploadedFiles || []);
      setSelectedItems(currentProject.selectedItems || []);
      setChatHistory(currentProject.chatHistory || []);
      setExperts(currentProject.experts || EXPERT_PRESETS.education);
      setSelectedExperts(currentProject.selectedExperts || ['curriculum', 'teacher', 'evaluator']);
      setDataName(currentProject.dataName || '');
      setDataSchema(currentProject.dataSchema || []);
    }
  }, [currentProjectId]);

  // Auto-save current project data
  useEffect(() => {
    if (currentProjectId && currentProject) {
      const updatedProject = {
        ...currentProject,
        items,
        uploadedFiles,
        selectedItems,
        chatHistory,
        experts,
        selectedExperts,
        dataName,
        dataSchema,
        updatedAt: new Date().toISOString(),
      };
      setProjects(prev => prev.map(p => p.id === currentProjectId ? updatedProject : p));
    }
  }, [items, uploadedFiles, selectedItems, chatHistory, experts, selectedExperts, dataName, dataSchema]);

  // Save to localStorage
  useEffect(() => {
    localStorage.setItem('context_chat_experts', JSON.stringify(experts));
  }, [experts]);

  useEffect(() => {
    localStorage.setItem('context_chat_selected_experts', JSON.stringify(selectedExperts));
  }, [selectedExperts]);

  useEffect(() => {
    localStorage.setItem('context_chat_sessions', JSON.stringify(savedSessions));
  }, [savedSessions]);

  useEffect(() => {
    localStorage.setItem('context_chat_expert_ratings', JSON.stringify(expertRatings));
  }, [expertRatings]);

  useEffect(() => {
    localStorage.setItem('context_chat_expert_memory', JSON.stringify(expertMemory));
  }, [expertMemory]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatHistory]);

  // Project Management Functions
  const createProject = () => {
    if (!newProjectName.trim()) return;
    const newProject = {
      id: `project_${Date.now()}`,
      name: newProjectName.trim(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      items: [],
      uploadedFiles: [],
      selectedItems: [],
      chatHistory: [],
      experts: EXPERT_PRESETS.education,
      selectedExperts: ['curriculum', 'teacher', 'evaluator'],
      dataName: '',
      dataSchema: [],
    };
    setProjects(prev => [newProject, ...prev]);
    setCurrentProjectId(newProject.id);
    setNewProjectName('');
    setShowProjectManager(false);
    // Reset current state
    setItems([]);
    setUploadedFiles([]);
    setSelectedItems([]);
    setChatHistory([]);
    setDataName('');
    setDataSchema([]);
  };

  const deleteProject = (projectId) => {
    if (!confirm('이 프로젝트를 삭제하시겠습니까?')) return;
    setProjects(prev => prev.filter(p => p.id !== projectId));
    if (currentProjectId === projectId) {
      setCurrentProjectId(null);
      setItems([]);
      setUploadedFiles([]);
      setSelectedItems([]);
      setChatHistory([]);
    }
  };

  const exportProject = (project) => {
    const data = JSON.stringify(project, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${project.name}_export.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importProject = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const imported = JSON.parse(evt.target.result);
        imported.id = `project_${Date.now()}`;
        imported.name = `${imported.name} (imported)`;
        imported.updatedAt = new Date().toISOString();
        setProjects(prev => [imported, ...prev]);
      } catch (err) {
        alert('프로젝트 가져오기 실패: ' + err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  // Handle Preset Change
  const handlePresetChange = (presetKey) => {
    setSelectedPreset(presetKey);
    if (EXPERT_PRESETS[presetKey]) {
      setExperts(EXPERT_PRESETS[presetKey]);
      setSelectedExperts(EXPERT_PRESETS[presetKey].map(e => e.id));
    }
  };

  // AI Expert Recommendation with Names
  const handleRecommendExperts = async () => {
    if (!items.length) return;
    const sampleData = JSON.stringify(items.slice(0, 3), null, 2);
    const prompt = `다음 데이터를 분석하고, 이 주제에 가장 적합한 전문가 3명을 추천해주세요.
주제가 한국어면 한국 이름, 영어면 영어 이름을 사용하세요.

데이터: ${sampleData}

다음 형식으로 JSON 배열만 응답해주세요:
[{"id": "expert1", "name": "홍길동 또는 John Doe", "role": "직업/전문분야", "emoji": "🎯", "color": "#3b82f6", "bgClass": "bg-blue-50 border-blue-200", "systemPrompt": "너는 [이름]이야. [역할]에 대해 전문적으로 조언해..."}]`;

    try {
      setIsGenerating(true);
      const text = await fetchChat(provider, selectedModel,
        [{ role: 'user', content: prompt }], '');
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        try {
          const recommended = JSON.parse(jsonMatch[0]);
          setExperts(recommended);
          setSelectedExperts(recommended.map(e => e.id));
          setSelectedPreset('custom');
        } catch (parseErr) {
          console.error('Failed to parse expert recommendation JSON:', parseErr);
          alert('전문가 추천 결과 파싱 실패. 다시 시도해주세요.');
        }
      }
    } catch (error) {
      console.error('Expert recommendation failed:', error);
      alert('전문가 추천 실패: ' + error.message);
    } finally {
      setIsGenerating(false);
    }
  };

  // Generate Summary
  const handleGenerateSummary = async () => {
    if (!chatHistory.length) return;
    const discussionText = chatHistory.map(msg => {
      if (msg.role === 'user') return `[사용자]: ${msg.text}`;
      if (msg.role === 'expert') return `[${msg.expertName}]: ${msg.text}`;
      return '';
    }).filter(Boolean).join('\n\n');

    const prompt = `다음 토론 내용을 간결하게 요약해주세요. 핵심 포인트와 결론을 중심으로:

${discussionText}`;

    try {
      setIsGenerating(true);
      const summary = await fetchChat(provider, selectedModel,
        [{ role: 'user', content: prompt }], '');
      setChatHistory(prev => [...prev, { role: 'summary', text: summary }]);
    } catch (error) {
      alert('요약 생성 실패: ' + error.message);
    } finally {
      setIsGenerating(false);
    }
  };

  // Export to Markdown
  const handleExportMarkdown = () => {
    const lines = ['# 전문가 토론 기록\n', `날짜: ${new Date().toLocaleString('ko-KR')}\n`];
    if (currentProject) lines.push(`프로젝트: ${currentProject.name}\n`);
    lines.push('---\n');

    chatHistory.forEach(msg => {
      if (msg.role === 'user') {
        lines.push(`## 💬 사용자 질문\n${msg.text}\n`);
      } else if (msg.role === 'expert') {
        const expert = experts.find(e => e.id === msg.expertId) || {};
        lines.push(`## ${expert.emoji || '🎭'} ${msg.expertName}(${expert.role || '전문가'})\n${msg.text}\n`);
      } else if (msg.role === 'summary') {
        lines.push(`## 📋 요약\n${msg.text}\n`);
      }
    });

    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `discussion_${Date.now()}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Export to PDF
  const handleExportPDF = async () => {
    const chatContainer = document.getElementById('chat-container');
    if (!chatContainer) return;

    try {
      const canvas = await html2canvas(chatContainer, {
        scale: 2,
        useCORS: true,
        backgroundColor: '#ffffff'
      });
      const imgData = canvas.toDataURL('image/png');
      const pdf = new jsPDF('p', 'mm', 'a4');
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const imgWidth = pageWidth - 20;
      const imgHeight = (canvas.height * imgWidth) / canvas.width;

      let heightLeft = imgHeight;
      let position = 10;

      pdf.addImage(imgData, 'PNG', 10, position, imgWidth, imgHeight);
      heightLeft -= pageHeight;

      while (heightLeft >= 0) {
        position = heightLeft - imgHeight;
        pdf.addPage();
        pdf.addImage(imgData, 'PNG', 10, position, imgWidth, imgHeight);
        heightLeft -= pageHeight;
      }

      pdf.save(`discussion_${Date.now()}.pdf`);
    } catch (error) {
      alert('PDF 내보내기 실패: ' + error.message);
    }
  };

  // Parse Text/JSON Input
  const handleParseText = () => {
    try {
      const parsed = JSON.parse(textInput);
      if (Array.isArray(parsed)) {
        setItems(prev => [...prev, ...parsed]);
        if (parsed.length > 0) setDataSchema(Object.keys(parsed[0]));
        setDataName('JSON 데이터');
      } else {
        setItems(prev => [...prev, parsed]);
        setDataSchema(Object.keys(parsed));
        setDataName('JSON 항목');
      }
    } catch {
      const lines = textInput.trim().split('\n').filter(l => l.trim());
      const newItems = lines.map((text, i) => ({ id: `text_${Date.now()}_${i}`, text }));
      setItems(prev => [...prev, ...newItems]);
      setDataSchema(['text']);
      setDataName('텍스트 데이터');
    }
    setTextInput('');
  };

  // Parse PDF file - returns single whole-file item
  const parsePDF = async (file) => {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const allText = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items.map(item => item.str).join(' ');
      if (pageText.trim()) allText.push(pageText);
    }
    // Return single item with full content
    return [{
      id: `pdf_${Date.now()}`,
      text: allText.join('\n\n'),
      source: file.name,
      type: 'pdf',
      isWholeFile: true,
      pageCount: pdf.numPages
    }];
  };

  // Parse DOCX file - returns single whole-file item
  const parseDOCX = async (file) => {
    const arrayBuffer = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer });
    // Return single item with full content
    return [{
      id: `docx_${Date.now()}`,
      text: result.value.trim(),
      source: file.name,
      type: 'docx',
      isWholeFile: true
    }];
  };

  // Parse Markdown/Text file - returns single whole-file item
  const parseMD = async (file) => {
    const text = await file.text();
    // Return single item with full content
    return [{
      id: `md_${Date.now()}`,
      text: text.trim(),
      source: file.name,
      type: file.name.endsWith('.md') ? 'md' : 'txt',
      isWholeFile: true
    }];
  };

  // Handle Multiple File Upload
  const handleFileUpload = async (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;

    // File count limit
    const MAX_FILE_COUNT = 10;
    if (files.length > MAX_FILE_COUNT) {
      alert(`한 번에 최대 ${MAX_FILE_COUNT}개의 파일만 업로드할 수 있습니다.`);
      e.target.value = '';
      return;
    }

    // File size limit (10MB per file)
    const MAX_FILE_SIZE = 10 * 1024 * 1024;
    const oversizedFile = files.find(f => f.size > MAX_FILE_SIZE);
    if (oversizedFile) {
      alert(`파일 크기는 10MB를 초과할 수 없습니다. ("${oversizedFile.name}" - ${(oversizedFile.size / 1024 / 1024).toFixed(1)}MB)`);
      e.target.value = '';
      return;
    }

    setIsParsingFile(true);
    const allNewItems = [];
    const newUploadedFiles = [];

    for (const file of files) {
      const ext = file.name.split('.').pop().toLowerCase();
      try {
        let parsedItems = [];

        if (ext === 'pdf') {
          parsedItems = await parsePDF(file);
        } else if (ext === 'docx') {
          parsedItems = await parseDOCX(file);
        } else if (ext === 'md' || ext === 'txt') {
          parsedItems = await parseMD(file);
        } else if (ext === 'json') {
          const text = await file.text();
          const parsed = JSON.parse(text);
          const arr = Array.isArray(parsed) ? parsed : [parsed];
          parsedItems = arr.map((item, i) => ({
            ...item,
            id: item.id || `json_${Date.now()}_${i}`,
            source: file.name,
            type: 'json'
          }));
        } else if (ext === 'csv' || ext === 'xlsx' || ext === 'xls') {
          const arrayBuffer = await file.arrayBuffer();
          const workbook = XLSX.read(arrayBuffer, { type: 'array' });
          const sheetName = workbook.SheetNames[0];
          const data = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
          parsedItems = data.map((row, i) => ({
            ...row,
            id: `excel_${Date.now()}_${i}`,
            source: file.name,
            type: ext
          }));
        }

        if (parsedItems.length > 0) {
          allNewItems.push(...parsedItems);
          newUploadedFiles.push({
            name: file.name,
            size: file.size,
            type: ext,
            itemCount: parsedItems.length,
            uploadedAt: new Date().toISOString()
          });
        }

        // Update schema from first file with items
        if (parsedItems.length > 0 && dataSchema.length === 0) {
          setDataSchema(Object.keys(parsedItems[0]));
        }
      } catch (err) {
        console.error(`Error parsing ${file.name}:`, err);
        alert(`파일 파싱 오류 (${file.name}): ${err.message}`);
      }
    }

    setItems(prev => [...prev, ...allNewItems]);
    setUploadedFiles(prev => [...prev, ...newUploadedFiles]);
    setDataName(`${files.length}개 파일`);
    setIsParsingFile(false);
    e.target.value = '';
  };

  // Crawl URL (reusable function)
  const crawlUrl = async (url) => {
    try {
      const response = await fetch(`/api/fetch-url?url=${encodeURIComponent(url)}`);
      const data = await response.json();
      if (data.error) throw new Error(data.message || data.error);

      const urlItems = [];
      if (data.listItems?.length) {
        data.listItems.forEach((text, i) => {
          urlItems.push({ id: `url_${Date.now()}_${i}`, text, type: 'url', source: url });
        });
      }
      if (data.tables?.length) {
        data.tables.forEach((table, ti) => {
          const headers = table[0] || [];
          table.slice(1).forEach((row, ri) => {
            const item = { id: `table${ti}_${ri}`, type: 'table', source: url };
            headers.forEach((h, ci) => { item[h || `col${ci}`] = row[ci] || ''; });
            urlItems.push(item);
          });
        });
      }
      if (urlItems.length === 0 && data.content) {
        const paragraphs = data.content.split(/[.!?]\s+/).filter(p => p.length > 20);
        paragraphs.slice(0, 20).forEach((text, i) => {
          urlItems.push({ id: `content_${Date.now()}_${i}`, text: text.trim() + '.', type: 'content', source: url });
        });
      }

      setItems(prev => [...prev, ...urlItems]);
      setUploadedFiles(prev => [...prev, { name: data.title || url, type: 'url', itemCount: urlItems.length, uploadedAt: new Date().toISOString() }]);
      if (urlItems.length > 0 && dataSchema.length === 0) {
        setDataSchema(Object.keys(urlItems[0]));
      }
      setDataName(data.title || url);

      // Add success message to chat
      setChatHistory(prev => [...prev, {
        role: 'system',
        text: `🌐 "${data.title || url}"에서 ${urlItems.length}개 항목을 크롤링했습니다.`,
        crawledUrl: url
      }]);

      return { success: true, itemCount: urlItems.length, title: data.title };
    } catch (error) {
      console.error('URL fetch error:', error);
      setChatHistory(prev => [...prev, {
        role: 'error',
        text: `URL 크롤링 실패: ${error.message}`
      }]);
      return { success: false, error: error.message };
    }
  };

  // Fetch URL (original handler for URL input)
  const handleFetchUrl = async () => {
    if (!urlInput.trim()) return;
    setIsFetchingUrl(true);
    await crawlUrl(urlInput);
    setUrlInput('');
    setIsFetchingUrl(false);
  };

  // Handle in-chat URL crawl
  const [crawlingUrl, setCrawlingUrl] = useState(null);
  const handleCrawlFromChat = async (url) => {
    if (crawlingUrl) return; // Prevent multiple simultaneous crawls
    setCrawlingUrl(url);
    await crawlUrl(url);
    setCrawlingUrl(null);
  };

  // Toggle Item Selection
  const toggleItem = (item) => {
    const itemId = item.id ?? JSON.stringify(item);
    setSelectedItems(prev => {
      if (prev.find(i => (i.id ?? JSON.stringify(i)) === itemId)) {
        return prev.filter(i => (i.id ?? JSON.stringify(i)) !== itemId);
      }
      return [...prev, item];
    });
  };

  // Build Context String
  const buildContext = () => {
    if (selectedItems.length === 0) return '';
    return `[선택된 데이터 (${selectedItems.length}개)]:\n` +
      selectedItems.map((item, i) =>
        `${i + 1}. ${dataSchema.slice(0, 3).map(k => `${k}: ${item[k]}`).join(', ')}`
      ).join('\n');
  };

  // Save Session
  const saveSession = () => {
    const session = {
      id: Date.now(),
      timestamp: new Date().toISOString(),
      projectName: currentProject?.name || 'Unknown',
      dataName,
      expertNames: experts.filter(e => selectedExperts.includes(e.id)).map(e => e.name),
      chatHistory: chatHistory.slice(-20),
      itemCount: selectedItems.length,
    };
    setSavedSessions(prev => [session, ...prev].slice(0, 20));
  };

  // Rate Expert
  const rateExpert = (expertId, rating) => {
    setExpertRatings(prev => ({ ...prev, [expertId]: { rating, timestamp: Date.now() } }));
  };

  // Update Expert Memory
  const updateExpertMemory = (expertId, expertName, text) => {
    setExpertMemory(prev => ({
      ...prev,
      [expertId]: {
        name: expertName,
        history: [...(prev[expertId]?.history || []).slice(-5), { text: text.slice(0, 500), timestamp: Date.now() }]
      }
    }));
  };

  // Clear all data
  const clearAllData = () => {
    if (!confirm('모든 데이터를 삭제하시겠습니까?')) return;
    setItems([]);
    setUploadedFiles([]);
    setSelectedItems([]);
    setDataSchema([]);
    setDataName('');
  };

  // Multi-Expert Discussion
  const handleStartDiscussion = async () => {
    if (!chatInput.trim() || isDiscussing) return;

    const userQuestion = chatInput;
    setChatHistory(prev => [...prev, { role: 'user', text: userQuestion }]);
    setChatInput('');
    setIsDiscussing(true);

    try {
      const context = buildContext();
      const activeExperts = experts.filter(e => selectedExperts.includes(e.id));
      let conversationHistory = [];

      for (let round = 0; round < discussionRounds; round++) {
        for (const expert of activeExperts) {
          const prevResponses = conversationHistory.map(c => `[${c.expertName}]: ${c.text}`).join('\n\n');
          const memory = expertMemory[expert.id];
          const memoryContext = memory?.history?.length
            ? `\n[이전 프로젝트에서의 발언 기록]:\n${memory.history.map(h => h.text).join('\n---\n')}\n`
            : '';

          const userContent = `${memoryContext}
${context ? `\n${context}\n` : ''}
[사용자 질문]: ${userQuestion}
${prevResponses ? `[이전 토론 내용]:\n${prevResponses}\n\n` : ''}
위 내용을 바탕으로 ${expert.name} 관점에서 의견을 제시해줘.`;

          const expertMsg = {
            role: 'expert',
            expertId: expert.id,
            expertName: expert.name,
            expertColor: expert.color,
            expertBgClass: expert.bgClass,
            text: ""
          };
          setChatHistory(prev => [...prev, expertMsg]);

          const fullText = await fetchStream(provider, selectedModel,
            [{ role: 'user', content: userContent }],
            expert.systemPrompt,
            (text) => {
              setChatHistory(prev => {
                const newHistory = [...prev];
                const lastMsg = newHistory[newHistory.length - 1];
                if (lastMsg.role === 'expert' && lastMsg.expertId === expert.id) {
                  lastMsg.text = text;
                }
                return newHistory;
              });
            }
          );

          conversationHistory.push({ expertId: expert.id, expertName: expert.name, text: fullText });
          updateExpertMemory(expert.id, expert.name, fullText);

          // Extract URLs from expert response for auto-suggestion
          const urlRegex = /https?:\/\/[^\s<>"{}|\\^`[\]]+/g;
          const foundUrls = fullText.match(urlRegex) || [];
          if (foundUrls.length > 0) {
            setChatHistory(prev => [...prev, {
              role: 'suggestion',
              text: `💡 ${expert.name}의 답변에서 ${foundUrls.length}개의 URL을 발견했습니다. 크롤링할까요?`,
              urls: [...new Set(foundUrls)].slice(0, 5)
            }]);
          }
        }
      }
      saveSession();
    } catch (error) {
      console.error(error);
      setChatHistory(prev => [...prev, { role: 'error', text: `오류: ${error.message}` }]);
    } finally {
      setIsDiscussing(false);
    }
  };

  return (
    <div className="min-h-screen text-slate-800 font-sans">
      {/* Background */}
      <div className="fixed top-0 left-0 w-full h-full overflow-hidden -z-10 pointer-events-none">
        <div className="absolute top-[-10%] left-[-10%] w-[500px] h-[500px] bg-indigo-300 rounded-full mix-blend-multiply filter blur-3xl opacity-30 animate-blob"></div>
        <div className="absolute top-[-10%] right-[-10%] w-[500px] h-[500px] bg-purple-300 rounded-full mix-blend-multiply filter blur-3xl opacity-30 animate-blob animation-delay-2000"></div>
        <div className="absolute bottom-[-20%] left-[20%] w-[500px] h-[500px] bg-pink-300 rounded-full mix-blend-multiply filter blur-3xl opacity-30 animate-blob animation-delay-4000"></div>
      </div>

      <div className="max-w-[1600px] mx-auto h-screen p-4 md:p-6 flex flex-col gap-4">

        {/* Header */}
        <header className="glass-panel rounded-2xl px-6 py-4 flex justify-between items-center">
          <div className="flex items-center gap-3">
            <div className="bg-gradient-to-br from-purple-600 to-indigo-600 text-white p-2.5 rounded-xl shadow-lg">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 01-.825-.242m9.345-8.344a2.126 2.126 0 00-.476-.095 48.64 48.64 0 00-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0011.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155" />
              </svg>
            </div>
            <div>
              <h1 className="text-xl font-bold bg-gradient-to-r from-purple-600 to-indigo-600 bg-clip-text text-transparent">Context Chat</h1>
              <p className="text-xs text-slate-500">
                {currentProject ? `📂 ${currentProject.name}` : 'Multi-Expert Discussion System'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowProjectManager(true)}
              className="text-xs bg-gradient-to-r from-purple-500 to-indigo-500 text-white rounded-lg px-3 py-1.5 hover:from-purple-600 hover:to-indigo-600 transition"
            >
              📁 프로젝트 ({projects.length})
            </button>
            <button
              onClick={() => setShowSessionManager(true)}
              className="text-xs bg-white/50 border border-white/50 rounded-lg px-3 py-1.5 hover:bg-white transition"
            >
              📚 세션 ({savedSessions.length})
            </button>
            <select
              value={provider}
              onChange={(e) => handleSaveProvider(e.target.value)}
              className="text-xs bg-white/50 border border-white/50 rounded-lg px-2 py-1.5"
            >
              {Object.entries(MODEL_OPTIONS).map(([key, val]) => (
                <option key={key} value={key}>{val.label}</option>
              ))}
            </select>
            <select
              value={selectedModel}
              onChange={(e) => handleSaveModel(e.target.value)}
              className="text-xs bg-white/50 border border-white/50 rounded-lg px-2 py-1.5"
            >
              {MODEL_OPTIONS[provider].models.map(m => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
            <button onClick={() => setShowSettings(true)} className="text-slate-500 hover:text-slate-700">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>
          </div>
        </header>

        {/* Main Grid */}
        <div className="flex-1 grid grid-cols-12 gap-4 min-h-0">

          {/* Left Panel: Data Input & Items */}
          <div className="col-span-4 flex flex-col gap-4 min-h-0">

            {/* Data Input */}
            <div className="glass-panel rounded-2xl p-4">
              <div className="flex gap-2 mb-3">
                {['text', 'file', 'url'].map(mode => (
                  <button
                    key={mode}
                    onClick={() => setInputMode(mode)}
                    className={`text-xs px-3 py-1.5 rounded-lg transition ${inputMode === mode
                      ? 'bg-purple-600 text-white'
                      : 'bg-white/50 text-slate-600 hover:bg-white'
                      }`}
                  >
                    {mode === 'text' ? '📝 텍스트' : mode === 'file' ? '📄 파일' : '🌐 URL'}
                  </button>
                ))}
              </div>

              {inputMode === 'text' ? (
                <div>
                  <textarea
                    value={textInput}
                    onChange={(e) => setTextInput(e.target.value)}
                    placeholder='JSON 배열 또는 텍스트를 입력하세요...'
                    className="w-full h-24 p-3 text-sm bg-white/50 border border-white/50 rounded-xl resize-none"
                  />
                  <button onClick={handleParseText} className="mt-2 w-full py-2 bg-purple-600 text-white text-sm rounded-xl hover:bg-purple-700 transition">
                    ➕ 데이터 추가
                  </button>
                </div>
              ) : inputMode === 'file' ? (
                <div className="border-2 border-dashed border-purple-200 rounded-xl p-4 text-center hover:border-purple-400 transition cursor-pointer">
                  <input
                    type="file"
                    accept=".json,.csv,.xlsx,.xls,.pdf,.docx,.md,.txt"
                    multiple
                    onChange={handleFileUpload}
                    className="hidden"
                    id="file-upload"
                    disabled={isParsingFile}
                  />
                  <label htmlFor="file-upload" className="cursor-pointer">
                    <div className="text-3xl mb-2">{isParsingFile ? '⏳' : '📁'}</div>
                    <p className="text-sm text-slate-600 font-medium">
                      {isParsingFile ? '파싱 중...' : '여러 파일 동시 업로드'}
                    </p>
                    <p className="text-xs text-slate-400 mt-1">
                      PDF, DOCX, MD, Excel, CSV, JSON
                    </p>
                  </label>
                </div>
              ) : (
                <div>
                  <input
                    type="url"
                    value={urlInput}
                    onChange={(e) => setUrlInput(e.target.value)}
                    placeholder="https://example.com/page"
                    className="w-full p-3 text-sm bg-white/50 border border-white/50 rounded-xl"
                  />
                  <button
                    onClick={handleFetchUrl}
                    disabled={isFetchingUrl}
                    className="mt-2 w-full py-2 bg-purple-600 text-white text-sm rounded-xl hover:bg-purple-700 transition disabled:opacity-50"
                  >
                    {isFetchingUrl ? '⏳ 가져오는 중...' : '🌐 웹페이지 가져오기'}
                  </button>
                </div>
              )}
            </div>

            {/* Uploaded Files Summary */}
            {uploadedFiles.length > 0 && (
              <div className="glass-panel rounded-2xl p-3">
                <div className="flex justify-between items-center mb-2">
                  <span className="text-xs font-bold text-slate-600">📎 업로드된 파일 ({uploadedFiles.length})</span>
                  <button onClick={clearAllData} className="text-xs text-red-500 hover:underline">전체삭제</button>
                </div>
                <div className="flex flex-wrap gap-1">
                  {uploadedFiles.map((file, i) => (
                    <span key={i} className="text-xs bg-purple-100 text-purple-700 px-2 py-1 rounded-full">
                      {file.name.slice(0, 20)} ({file.itemCount})
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Items List */}
            <div className="glass-panel rounded-2xl p-4 flex-1 overflow-hidden flex flex-col">
              <div className="flex justify-between items-center mb-3">
                <h2 className="font-bold text-slate-700">
                  {dataName || '데이터 목록'}
                  <span className="text-xs text-slate-400 ml-2">({items.length}개)</span>
                </h2>
                {items.length > 0 && (
                  <div className="flex gap-2">
                    <button onClick={() => setSelectedItems(items)} className="text-xs text-purple-600 hover:underline">전체선택</button>
                    <button onClick={() => setSelectedItems([])} className="text-xs text-slate-400 hover:underline">해제</button>
                  </div>
                )}
              </div>

              {items.length > 0 && (
                <button
                  onClick={handleRecommendExperts}
                  disabled={isGenerating}
                  className="mb-3 w-full py-2 bg-gradient-to-r from-purple-500 to-indigo-500 text-white text-xs rounded-xl hover:from-purple-600 hover:to-indigo-600 transition disabled:opacity-50"
                >
                  {isGenerating ? '🤔 분석중...' : '✨ AI 전문가 추천'}
                </button>
              )}

              <div className="flex-1 overflow-y-auto space-y-2 custom-scrollbar">
                {items.map((item, i) => {
                  const isSelected = selectedItems.find(si => (si.id ?? JSON.stringify(si)) === (item.id ?? JSON.stringify(item)));
                  const typeIcon = item.isWholeFile ? '📄' : item.type === 'xlsx' || item.type === 'csv' ? '📊' : '📝';
                  const typeBadge = item.type?.toUpperCase() || 'DATA';
                  return (
                    <div
                      key={i}
                      onClick={() => toggleItem(item)}
                      className={`p-3 rounded-xl cursor-pointer transition border ${isSelected
                        ? 'bg-purple-50 border-purple-300'
                        : 'bg-white/50 border-white hover:border-purple-200'
                        }`}
                    >
                      <div className="flex items-start gap-2">
                        <span className="text-lg">{typeIcon}</span>
                        <div className="flex-1 min-w-0">
                          {item.isWholeFile ? (
                            <>
                              <div className="flex items-center gap-2 mb-1">
                                <span className="text-xs px-1.5 py-0.5 bg-purple-100 text-purple-700 rounded font-medium">{typeBadge}</span>
                                <span className="text-sm font-medium text-slate-700 truncate">{item.source}</span>
                                {item.pageCount && <span className="text-xs text-slate-400">({item.pageCount}p)</span>}
                              </div>
                              <p className="text-xs text-slate-500 line-clamp-2">{item.text?.slice(0, 150)}...</p>
                            </>
                          ) : (
                            <>
                              <div className="text-sm text-slate-700 line-clamp-2">
                                {item.text || dataSchema.slice(0, 2).map(key => item[key]).filter(Boolean).join(' - ') || JSON.stringify(item).slice(0, 80)}
                              </div>
                              {item.source && (
                                <p className="text-xs text-slate-400 mt-1">📄 {item.source}</p>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
                {items.length === 0 && (
                  <div className="text-center text-slate-400 py-8">
                    <p className="text-2xl mb-2">📋</p>
                    <p className="text-sm">데이터를 입력하세요</p>
                    <p className="text-xs text-slate-300 mt-1">여러 파일 동시 업로드 가능</p>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Right Panel: Expert Chat */}
          <div className="col-span-8 glass-panel rounded-2xl flex flex-col overflow-hidden">

            {/* Chat Header */}
            <div className="bg-white/30 p-4 border-b border-white/20">
              <div className="flex justify-between items-center mb-2">
                <span className="font-bold text-slate-700 flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${isDiscussing ? 'bg-yellow-500' : 'bg-green-500'} animate-pulse`}></span>
                  🎭 Multi-Expert Discussion
                </span>
                {chatHistory.length > 0 && (
                  <div className="flex gap-2">
                    <button onClick={saveSession} className="text-xs text-green-600 hover:underline">💾 저장</button>
                    <button onClick={() => setChatHistory([])} className="text-xs text-slate-400 hover:text-red-500 underline">Clear</button>
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-slate-500">프리셋:</span>
                <select
                  value={selectedPreset}
                  onChange={(e) => handlePresetChange(e.target.value)}
                  className="bg-white/50 border border-white/50 rounded-lg px-2 py-1"
                >
                  {Object.entries(PRESET_DESCRIPTIONS).map(([key, desc]) => (
                    <option key={key} value={key}>{desc}</option>
                  ))}
                </select>

                <span className="text-slate-400 ml-2">전문가:</span>
                {experts.map(expert => (
                  <label key={expert.id} className="flex items-center gap-1 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedExperts.includes(expert.id)}
                      onChange={(e) => {
                        if (e.target.checked) setSelectedExperts(prev => [...prev, expert.id]);
                        else setSelectedExperts(prev => prev.filter(id => id !== expert.id));
                      }}
                      className="w-3 h-3 rounded"
                    />
                    <span className="px-2 py-0.5 rounded-full flex items-center gap-1" style={{ backgroundColor: expert.color + '20', color: expert.color }}>
                      {expert.emoji} {expert.name}({expert.role || '전문가'})
                      {expertRatings[expert.id]?.rating && <span>⭐</span>}
                    </span>
                  </label>
                ))}

                <span className="text-slate-400 ml-2">라운드:</span>
                <select value={discussionRounds} onChange={(e) => setDiscussionRounds(Number(e.target.value))} className="bg-white/50 border border-white/50 rounded px-1 py-0.5">
                  <option value={1}>1</option>
                  <option value={2}>2</option>
                  <option value={3}>3</option>
                </select>

                <button onClick={() => setShowExpertEditor(true)} className="text-purple-600 hover:text-purple-800 ml-2 underline">
                  ✏️ 편집
                </button>
              </div>
            </div>

            {/* Chat Messages */}
            <div id="chat-container" className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar bg-white">
              {/* Export Buttons */}
              {chatHistory.length > 0 && (
                <div className="flex gap-2 justify-end mb-2 sticky top-0 bg-white/80 backdrop-blur-sm p-2 -mt-2 rounded-lg z-10">
                  <button
                    onClick={handleGenerateSummary}
                    disabled={isGenerating}
                    className="text-xs px-3 py-1.5 bg-emerald-100 text-emerald-700 rounded-lg hover:bg-emerald-200 transition disabled:opacity-50"
                  >
                    📋 요약 생성
                  </button>
                  <button
                    onClick={handleExportMarkdown}
                    className="text-xs px-3 py-1.5 bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200 transition"
                  >
                    📄 MD 내보내기
                  </button>
                  <button
                    onClick={handleExportPDF}
                    className="text-xs px-3 py-1.5 bg-red-100 text-red-700 rounded-lg hover:bg-red-200 transition"
                  >
                    📕 PDF 내보내기
                  </button>
                </div>
              )}
              {chatHistory.length === 0 && (
                <div className="h-full flex flex-col items-center justify-center text-slate-400">
                  <p className="text-4xl mb-3">🎭</p>
                  <p className="text-sm">전문가들에게 질문하세요</p>
                  {selectedItems.length > 0 && (
                    <p className="text-xs text-purple-500 mt-2">선택된 데이터: {selectedItems.length}개</p>
                  )}
                </div>
              )}
              {chatHistory.map((msg, i) => (
                <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[85%] p-4 rounded-2xl shadow-sm ${msg.role === 'user'
                    ? 'bg-purple-600 text-white rounded-br-none'
                    : msg.role === 'error'
                      ? 'bg-red-50 text-red-600 border border-red-100'
                      : msg.role === 'suggestion'
                        ? 'bg-amber-50 text-amber-900 border border-amber-200 rounded-bl-none'
                        : msg.role === 'system'
                          ? 'bg-blue-50 text-blue-700 border border-blue-100 rounded-bl-none'
                          : msg.role === 'expert'
                            ? `${msg.expertBgClass} rounded-bl-none border`
                            : 'bg-white/80 text-slate-800 rounded-bl-none border border-white'
                    }`}>
                    {msg.role === 'expert' && (
                      <div className="flex items-center justify-between gap-2 mb-2 pb-2 border-b" style={{ borderColor: msg.expertColor + '40' }}>
                        <span className="text-sm font-bold" style={{ color: msg.expertColor }}>
                          {(() => {
                            const expert = experts.find(e => e.id === msg.expertId);
                            return expert ? `${expert.emoji || ''} ${msg.expertName}(${expert.role || '전문가'})` : msg.expertName;
                          })()}
                        </span>
                        <button
                          onClick={() => rateExpert(msg.expertId, true)}
                          className={`text-xs ${expertRatings[msg.expertId]?.rating ? 'text-yellow-500' : 'text-slate-300 hover:text-yellow-500'}`}
                        >
                          ⭐
                        </button>
                      </div>
                    )}
                    {msg.role === 'summary' && (
                      <div className="flex items-center gap-2 mb-2 pb-2 border-b border-emerald-200">
                        <span className="text-sm font-bold text-emerald-600">📋 토론 요약</span>
                      </div>
                    )}
                    {msg.role === 'system' && (
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-blue-600">{msg.text}</span>
                      </div>
                    )}
                    {msg.role === 'suggestion' && (
                      <div className="space-y-2">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-amber-700">{msg.text}</span>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {msg.urls?.map((url, idx) => (
                            <button
                              key={idx}
                              onClick={() => handleCrawlFromChat(url)}
                              disabled={crawlingUrl === url}
                              className="text-xs px-2 py-1 bg-amber-100 text-amber-800 rounded-lg hover:bg-amber-200 transition disabled:opacity-50 flex items-center gap-1 max-w-[200px] truncate"
                              title={url}
                            >
                              {crawlingUrl === url ? '⏳' : '🌐'} {new URL(url).hostname.replace('www.', '')}
                            </button>
                          ))}
                          {msg.urls?.length > 1 && (
                            <button
                              onClick={async () => {
                                for (const url of msg.urls) {
                                  await handleCrawlFromChat(url);
                                }
                              }}
                              disabled={crawlingUrl}
                              className="text-xs px-2 py-1 bg-purple-100 text-purple-800 rounded-lg hover:bg-purple-200 transition disabled:opacity-50"
                            >
                              🚀 모두 크롤링
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                    {(msg.role === 'model' || msg.role === 'expert' || msg.role === 'summary') ? (
                      <div className="prose prose-sm max-w-none prose-headings:text-slate-800 prose-p:text-slate-700 prose-strong:text-slate-900 prose-code:bg-slate-100 prose-code:px-1 prose-code:rounded prose-pre:bg-slate-900 prose-ul:my-1 prose-li:my-0">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          components={{
                            a: ({ href, children }) => {
                              const isExternal = href?.startsWith('http');
                              return (
                                <span className="inline-flex items-center gap-1 group">
                                  <a
                                    href={href}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-purple-600 hover:text-purple-800 underline"
                                  >
                                    {children}
                                  </a>
                                  {isExternal && (
                                    <button
                                      onClick={(e) => {
                                        e.preventDefault();
                                        handleCrawlFromChat(href);
                                      }}
                                      disabled={crawlingUrl === href}
                                      className="opacity-0 group-hover:opacity-100 transition-opacity text-xs px-1.5 py-0.5 bg-purple-100 text-purple-700 rounded hover:bg-purple-200 disabled:opacity-50 whitespace-nowrap"
                                      title="이 URL 크롤링하기"
                                    >
                                      {crawlingUrl === href ? '⏳' : '🌐 크롤링'}
                                    </button>
                                  )}
                                </span>
                              );
                            }
                          }}
                        >
                          {msg.text}
                        </ReactMarkdown>
                      </div>
                    ) : msg.role !== 'system' && (
                      <p className="leading-relaxed whitespace-pre-wrap">{msg.text}</p>
                    )}
                  </div>
                </div>
              ))}
              <div ref={chatEndRef}></div>
            </div>

            {/* Chat Input */}
            <div className="p-4 bg-white/40 border-t border-white/20">
              <div className="relative">
                <input
                  type="text"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing && !isDiscussing && chatInput.trim()) {
                      e.preventDefault();
                      handleStartDiscussion();
                    }
                  }}
                  placeholder="전문가들에게 질문하세요..."
                  disabled={isDiscussing}
                  className="w-full bg-white/80 rounded-xl pl-4 pr-12 py-3 shadow-sm focus:ring-2 focus:ring-purple-400/50"
                />
                <button
                  onClick={handleStartDiscussion}
                  disabled={isDiscussing || !chatInput.trim()}
                  className="absolute right-2 top-2 p-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition disabled:opacity-50"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5 transform -rotate-45">
                    <path d="M3.478 2.405a.75.75 0 00-.926.94l2.432 7.905H13.5a.75.75 0 010 1.5H4.984l-2.432 7.905a.75.75 0 00.926.94 60.519 60.519 0 0018.445-8.986.75.75 0 000-1.218A60.517 60.517 0 003.478 2.405z" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Settings Modal */}
      {showSettings && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-md flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-3xl shadow-2xl p-6 w-full max-w-md">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-bold text-slate-800">⚙️ AI 모델 설정</h2>
              <button onClick={() => setShowSettings(false)} className="text-slate-400 hover:text-slate-600">✕</button>
            </div>
            <p className="text-sm text-slate-500 mb-4">API 키는 서버에서 안전하게 관리됩니다.</p>
            <div className="mb-4">
              <label className="block text-xs font-bold text-slate-500 uppercase mb-2">프로바이더</label>
              <div className="flex gap-2">
                {Object.entries(MODEL_OPTIONS).map(([key, val]) => (
                  <button key={key} onClick={() => handleSaveProvider(key)}
                    className={`flex-1 py-2.5 rounded-xl font-bold text-sm transition-all ${provider === key ? 'bg-purple-600 text-white shadow-lg' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
                    {val.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="mb-4">
              <label className="block text-xs font-bold text-slate-500 uppercase mb-2">모델</label>
              <div className="space-y-2">
                {MODEL_OPTIONS[provider].models.map(m => (
                  <button key={m.id} onClick={() => handleSaveModel(m.id)}
                    className={`w-full text-left p-3 rounded-xl border transition-all ${selectedModel === m.id ? 'bg-purple-50 border-purple-300 text-purple-700' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'}`}>
                    <span className="font-bold">{m.name}</span>
                    <span className="text-xs ml-2 text-slate-400">{m.id}</span>
                  </button>
                ))}
              </div>
            </div>
            <button onClick={() => setShowSettings(false)}
              className="w-full py-3 bg-purple-600 text-white rounded-xl font-bold hover:bg-purple-700 transition">
              확인
            </button>
          </div>
        </div>
      )}

      {/* Expert Editor Modal */}
      {showExpertEditor && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-md flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-3xl shadow-2xl p-6 w-full max-w-2xl max-h-[80vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-bold text-slate-800">🎭 전문가 페르소나 편집</h2>
              <button onClick={() => setShowExpertEditor(false)} className="text-slate-400 hover:text-slate-600">✕</button>
            </div>
            <div className="space-y-4">
              {experts.map((expert, idx) => (
                <div key={idx} className="p-4 rounded-xl border" style={{ borderColor: expert.color + '40', backgroundColor: expert.color + '10' }}>
                  <div className="flex gap-2 mb-3">
                    <input
                      type="text"
                      value={expert.emoji || ''}
                      onChange={(e) => { const updated = [...experts]; updated[idx].emoji = e.target.value; setExperts(updated); }}
                      className="w-12 px-2 py-2 rounded-lg border border-slate-200 text-center text-lg"
                      placeholder="🎭"
                      maxLength={2}
                    />
                    <input
                      type="text"
                      value={expert.name}
                      onChange={(e) => { const updated = [...experts]; updated[idx].name = e.target.value; setExperts(updated); }}
                      className="flex-1 px-3 py-2 rounded-lg border border-slate-200 text-sm font-bold"
                      placeholder="이름 (예: 김민준, John Doe)"
                    />
                    <input
                      type="text"
                      value={expert.role || ''}
                      onChange={(e) => { const updated = [...experts]; updated[idx].role = e.target.value; setExperts(updated); }}
                      className="flex-1 px-3 py-2 rounded-lg border border-slate-200 text-sm"
                      placeholder="역할 (예: 교육과정 전문가)"
                    />
                    <input type="color" value={expert.color} onChange={(e) => { const updated = [...experts]; updated[idx].color = e.target.value; setExperts(updated); }} className="w-10 h-10 rounded-lg cursor-pointer" />
                  </div>
                  <textarea value={expert.systemPrompt} onChange={(e) => { const updated = [...experts]; updated[idx].systemPrompt = e.target.value; setExperts(updated); }} className="w-full px-3 py-2 rounded-lg border border-slate-200 text-xs" rows={3} placeholder="시스템 프롬프트 (예: 너는 [이름]이야. [역할]에 대해 전문적으로 조언해...)" />
                  <div className="flex justify-between items-center mt-2">
                    <button onClick={() => { setExperts(prev => prev.filter((_, i) => i !== idx)); setSelectedExperts(prev => prev.filter(id => id !== expert.id)); }} className="text-xs text-red-500 hover:text-red-700">삭제</button>
                    <span className="text-xs text-slate-400">{expert.emoji} {expert.name}({expert.role || '전문가'})</span>
                    {expertMemory[expert.id]?.history?.length > 0 && <span className="text-xs text-slate-400">💾 메모리: {expertMemory[expert.id].history.length}개</span>}
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-4">
              <button onClick={() => { const newId = `expert_${Date.now()}`; setExperts(prev => [...prev, { ...DEFAULT_EXPERT, id: newId }]); setSelectedExperts(prev => [...prev, newId]); }} className="w-full py-2 bg-slate-100 hover:bg-slate-200 rounded-lg text-sm font-medium transition">+ 전문가 추가</button>
            </div>
          </div>
        </div>
      )}

      {/* Project Manager Modal */}
      {showProjectManager && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-md flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-3xl shadow-2xl p-6 w-full max-w-2xl max-h-[80vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-bold text-slate-800">📁 프로젝트 관리</h2>
              <button onClick={() => setShowProjectManager(false)} className="text-slate-400 hover:text-slate-600">✕</button>
            </div>

            {/* New Project */}
            <div className="flex gap-2 mb-4">
              <input
                type="text"
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                placeholder="새 프로젝트 이름"
                className="flex-1 px-4 py-2 border border-slate-200 rounded-xl"
                onKeyDown={(e) => e.key === 'Enter' && createProject()}
              />
              <button onClick={createProject} className="px-4 py-2 bg-purple-600 text-white rounded-xl hover:bg-purple-700">생성</button>
            </div>

            {/* Import */}
            <div className="mb-4">
              <input type="file" accept=".json" onChange={importProject} className="hidden" id="import-project" />
              <label htmlFor="import-project" className="text-xs text-purple-600 hover:underline cursor-pointer">📥 프로젝트 가져오기 (JSON)</label>
            </div>

            {/* Project List */}
            {projects.length === 0 ? (
              <div className="text-center text-slate-400 py-8">
                <p className="text-2xl mb-2">📂</p>
                <p className="text-sm">프로젝트가 없습니다</p>
              </div>
            ) : (
              <div className="space-y-3">
                {projects.map((project) => (
                  <div
                    key={project.id}
                    className={`p-4 rounded-xl border transition cursor-pointer ${currentProjectId === project.id ? 'border-purple-400 bg-purple-50' : 'border-slate-200 hover:border-purple-300'}`}
                    onClick={() => { setCurrentProjectId(project.id); setShowProjectManager(false); }}
                  >
                    <div className="flex justify-between items-start">
                      <div>
                        <h3 className="font-bold text-slate-700">{project.name}</h3>
                        <p className="text-xs text-slate-400 mt-1">{new Date(project.updatedAt).toLocaleString('ko-KR')}</p>
                        <p className="text-xs text-slate-500 mt-1">
                          📄 {project.items?.length || 0}개 항목 | 💬 {project.chatHistory?.length || 0}개 메시지
                        </p>
                      </div>
                      <div className="flex gap-2">
                        <button onClick={(e) => { e.stopPropagation(); exportProject(project); }} className="text-xs text-blue-500 hover:underline">📤</button>
                        <button onClick={(e) => { e.stopPropagation(); deleteProject(project.id); }} className="text-xs text-red-400 hover:text-red-600">삭제</button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Session Manager Modal */}
      {showSessionManager && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-md flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-3xl shadow-2xl p-6 w-full max-w-2xl max-h-[80vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-bold text-slate-800">📚 저장된 세션</h2>
              <button onClick={() => setShowSessionManager(false)} className="text-slate-400 hover:text-slate-600">✕</button>
            </div>
            {savedSessions.length === 0 ? (
              <div className="text-center text-slate-400 py-8">
                <p className="text-2xl mb-2">📭</p>
                <p className="text-sm">저장된 세션이 없습니다</p>
              </div>
            ) : (
              <div className="space-y-3">
                {savedSessions.map((session, idx) => (
                  <div key={session.id} className="p-4 rounded-xl border border-slate-200 hover:border-purple-300 transition">
                    <div className="flex justify-between items-start">
                      <div>
                        <h3 className="font-bold text-slate-700">{session.projectName || session.dataName || '세션'}</h3>
                        <p className="text-xs text-slate-400 mt-1">{new Date(session.timestamp).toLocaleString('ko-KR')}</p>
                        <p className="text-xs text-slate-500 mt-1">전문가: {session.expertNames?.join(', ')} | 데이터: {session.itemCount}개</p>
                      </div>
                      <button onClick={() => setSavedSessions(prev => prev.filter((_, i) => i !== idx))} className="text-xs text-red-400 hover:text-red-600">삭제</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {savedSessions.length > 0 && (
              <button onClick={() => { if (confirm('모든 세션을 삭제하시겠습니까?')) setSavedSessions([]); }} className="mt-4 w-full py-2 bg-red-50 text-red-600 rounded-lg text-sm hover:bg-red-100 transition">전체 삭제</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
