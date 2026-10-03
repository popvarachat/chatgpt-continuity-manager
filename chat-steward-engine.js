(() => {
  'use strict';

  const ENGINE_VERSION = '1.0.0';
  const SCHEMA_VERSION = 1;
  const STATUSES = ['DELETE_CANDIDATE', 'REFERENCE', 'CONTINUE', 'PROJECT'];
  const MAX_MESSAGES = 40;
  const MAX_CONTENT_CHARS = 2400;

  const DEFAULT_PROJECTS = [
    { id: 'ai-automation', name: 'AI / Automation', keywords: ['agent', 'ai', 'automation', 'mcp', 'cli', 'api', 'skill', 'workflow', 'github', 'portal'] },
    { id: 'trading', name: 'Trading / Investment', keywords: ['trading', 'pine', 'tradingview', 'mt5', 'stock', 'หุ้น', 'gold', 'ทอง', 'btc', 'etf', 'broker'] },
    { id: 'geo-risk', name: 'Map / Geo / Risk', keywords: ['flood', 'map', 'น้ำท่วม', 'คลอง', 'route', 'routing', 'weather', 'ฝน', 'digital twin'] },
    { id: 'quality-iso', name: 'Quality / ISO', keywords: ['iso', 'qmr', 'quality', 'complaint', 'rca', 'capa', 'audit', 'qc', 'management review'] },
    { id: 'building', name: 'Building / Facility', keywords: ['building', 'as-built', 'asbuilt', 'facility', 'maintenance', 'อาคาร', 'ซ่อม', 'cad'] },
    { id: 'travel', name: 'Travel', keywords: ['travel', 'trip', 'flight', 'เที่ยว', 'โรงแรม', 'airline', 'airport'] },
    { id: 'finance', name: 'Finance / Personal Ops', keywords: ['credit card', 'finance', 'wallet', 'ค่าธรรมเนียม', 'บัตรเครดิต', 'usd', 'thb'] }
  ];

  const OPEN_CUES = [
    /\b(todo|pending|blocked|unfinished|continue|next step|follow[- ]?up|error|failed|fix|retry)\b/i,
    /(ทำต่อ|ต่อเลย|ต่อครับ|ยังไม่|ยังไม่ได้|ค้าง|แก้|ไม่ขึ้น|ผิดพลาด|ล้มเหลว|ติดอยู่|เหลือ|ดำเนินการต่อ|ให้จบ|ไม่เสร็จ|ต้องทำต่อ)/i
  ];
  const RESOLVED_CUES = [
    /\b(done|completed|complete|resolved|fixed|passed|success|finished|100%)\b/i,
    /(เสร็จแล้ว|เรียบร้อยแล้ว|แก้แล้ว|สำเร็จแล้ว|จบแล้ว|ผ่านแล้ว|ครบแล้ว)/i
  ];
  const REFERENCE_CUES = [
    /\b(workflow|architecture|formula|prompt|decision|policy|playbook|checklist|standard|rca|root cause|script|code|api|configuration|config|template|summary|report|spec|design)\b/i,
    /(สูตร|เวิร์กโฟลว์|สรุป|รายงาน|มาตรฐาน|นโยบาย|ขั้นตอน|โครงสร้าง|สถาปัตยกรรม|เช็กลิสต์|คำสั่ง|โค้ด|สคริปต์|แม่แบบ|ข้อกำหนด|การตัดสินใจ)/i
  ];
  const PROJECT_CUES = [
    /\b(project|repo|repository|portal|dashboard|roadmap|phase|milestone|backlog|sprint)\b/i,
    /(โครงการ|โปรเจกต์|พอร์ทัล|แดชบอร์ด|เฟส|ไมล์สโตน|งานค้าง|แผนงาน)/i
  ];
  const FILE_CUES = [
    /<<File name=/i,
    /\b(attached|attachment|uploaded file|spreadsheet|pptx|docx|pdf|csv|zip)\b/i,
    /(ไฟล์แนบ|แนบไฟล์|อัปโหลด|เอกสาร|สเปรดชีต)/i
  ];
  const ACTION_CUES = [
    /\b(next|then|should|need to|must|continue|fix|review|verify|test|deploy|update|create|add|remove|check)\b/i,
    /(ต่อไป|ควร|ต้อง|ทำต่อ|แก้|ตรวจ|ทดสอบ|อัปเดต|เพิ่ม|ลบ|สร้าง|เช็ก|ดำเนินการ)/i
  ];

  function clamp(n, min = 0, max = 100) {
    return Math.max(min, Math.min(max, Math.round(Number(n) || 0)));
  }

  function compactText(value, max = MAX_CONTENT_CHARS) {
    return String(value == null ? '' : value)
      .replace(/\u0000/g, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, max);
  }

  function textFromContent(content) {
    if (typeof content === 'string') return compactText(content);
    if (Array.isArray(content)) return compactText(content.map(textFromContent).filter(Boolean).join('\n'));
    if (!content || typeof content !== 'object') return '';
    if (Array.isArray(content.parts)) return compactText(content.parts.map(textFromContent).filter(Boolean).join('\n'));
    if (typeof content.text === 'string') return compactText(content.text);
    if (typeof content.content === 'string') return compactText(content.content);
    return '';
  }

  function extractMappingMessages(mapping) {
    if (!mapping || typeof mapping !== 'object') return [];
    return Object.values(mapping)
      .map((node, index) => {
        const message = node?.message;
        const role = message?.author?.role;
        if (role !== 'user' && role !== 'assistant') return null;
        return {
          role,
          content: textFromContent(message.content),
          create_time: Number(message.create_time || node.create_time || 0),
          _index: index
        };
      })
      .filter(x => x && x.content)
      .sort((a, b) => (a.create_time - b.create_time) || (a._index - b._index))
      .map(({ role, content }) => ({ role, content }));
  }

  function normalizeMessages(input) {
    let messages = [];
    if (Array.isArray(input?.messages)) {
      messages = input.messages.map(m => ({
        role: m?.role || m?.author?.role || '',
        content: textFromContent(m?.content ?? m?.text ?? m?.message?.content)
      }));
    } else if (input?.mapping && typeof input.mapping === 'object') {
      messages = extractMappingMessages(input.mapping);
    }
    return messages
      .filter(m => (m.role === 'user' || m.role === 'assistant') && m.content)
      .slice(-MAX_MESSAGES);
  }

  function normalizeConversation(input = {}, fallback = {}) {
    const messages = normalizeMessages(input);
    const title = compactText(input.title ?? fallback.title ?? 'Untitled chat', 240) || 'Untitled chat';
    const conversationId = compactText(
      input.conversation_id ?? input.id ?? fallback.conversation_id ?? fallback.id ?? '',
      180
    );
    const url = compactText(input.url ?? fallback.url ?? '', 1000);
    const createTime = input.create_time ?? fallback.create_time ?? null;
    const updateTime = input.update_time ?? fallback.update_time ?? null;
    const textdocs = Array.isArray(input.textdocs) ? input.textdocs : [];
    const attachments = Array.isArray(input.attachments) ? input.attachments : [];
    return {
      title,
      conversation_id: conversationId,
      url,
      create_time: createTime,
      update_time: updateTime,
      messages,
      textdocs_count: textdocs.length,
      attachment_count: attachments.length
    };
  }

  function countMatches(text, patterns) {
    return patterns.reduce((count, re) => count + (re.test(text) ? 1 : 0), 0);
  }

  function hasAny(text, patterns) {
    return patterns.some(re => re.test(text));
  }

  function tokenizeTitle(title) {
    const stop = new Set(['chatgpt', 'the', 'and', 'for', 'with', 'from', 'this', 'that', 'ครับ', 'ค่ะ', 'เรื่อง', 'ช่วย', 'ขอ']);
    return compactText(title, 300)
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .split(/\s+/)
      .filter(x => x.length > 1 && !stop.has(x));
  }

  function titleSimilarity(a, b) {
    const aa = new Set(tokenizeTitle(a));
    const bb = new Set(tokenizeTitle(b));
    if (!aa.size || !bb.size) return 0;
    let inter = 0;
    for (const token of aa) if (bb.has(token)) inter++;
    const union = new Set([...aa, ...bb]).size;
    return union ? inter / union : 0;
  }

  function duplicateRisk(title, existing = []) {
    let best = 0;
    let match = null;
    for (const record of existing) {
      const score = titleSimilarity(title, record?.title || '');
      if (score > best) {
        best = score;
        match = record;
      }
    }
    return {
      score: clamp(best * 100),
      similar_record_id: best >= 0.55 ? (match?.id || null) : null,
      similar_title: best >= 0.55 ? (match?.title || null) : null
    };
  }

  function normalizeProjectProfiles(profiles) {
    const raw = Array.isArray(profiles) && profiles.length ? profiles : DEFAULT_PROJECTS;
    return raw
      .map((p, i) => ({
        id: compactText(p?.id || `project-${i + 1}`, 80),
        name: compactText(p?.name || p?.id || `Project ${i + 1}`, 120),
        keywords: Array.isArray(p?.keywords) ? p.keywords.map(k => compactText(k, 80).toLowerCase()).filter(Boolean) : []
      }))
      .filter(p => p.name && p.keywords.length);
  }

  function projectMatch(title, text, profiles) {
    const hayTitle = String(title || '').toLowerCase();
    const hay = `${hayTitle}\n${String(text || '').toLowerCase()}`;
    let best = { id: null, name: null, score: 0, matched_keywords: [] };
    for (const p of normalizeProjectProfiles(profiles)) {
      const matched = [];
      let raw = 0;
      for (const kw of p.keywords) {
        if (!kw) continue;
        const titleHit = hayTitle.includes(kw);
        const textHit = hay.includes(kw);
        if (titleHit || textHit) {
          matched.push(kw);
          raw += titleHit ? 3 : 1;
        }
      }
      const score = clamp((raw / Math.max(4, p.keywords.length * 1.35)) * 100);
      if (score > best.score) best = { id: p.id, name: p.name, score, matched_keywords: matched.slice(0, 6) };
    }
    return best;
  }

  function latestOf(messages, role) {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === role) return messages[i].content;
    return '';
  }

  function detectOpenLoop(messages) {
    const tail = messages.slice(-8);
    const lastUser = latestOf(tail, 'user');
    const lastAssistant = latestOf(tail, 'assistant');
    const userOpen = hasAny(lastUser, OPEN_CUES);
    const assistantOpen = hasAny(lastAssistant, OPEN_CUES);
    const assistantResolved = hasAny(lastAssistant, RESOLVED_CUES);
    const lastRole = tail[tail.length - 1]?.role || '';
    const unresolvedByOrder = lastRole === 'user' && userOpen;
    const open = unresolvedByOrder || userOpen || (assistantOpen && !assistantResolved);
    return { open, userOpen, assistantOpen, assistantResolved };
  }

  function extractNextAction(messages, openLoop) {
    const tail = messages.slice(-10).reverse();
    for (const m of tail) {
      if (!ACTION_CUES.some(re => re.test(m.content))) continue;
      const lines = m.content.split(/\n+/).map(s => s.trim()).filter(Boolean);
      const preferred = lines.find(line => ACTION_CUES.some(re => re.test(line))) || lines[0];
      if (preferred) return compactText(preferred.replace(/^[-*•\d.)\s]+/, ''), 280);
    }
    if (openLoop) return 'Review the latest unresolved point, verify current state, then continue from the next safe action.';
    return 'No immediate action detected.';
  }

  function scoreConversation(conv, options = {}) {
    const messages = conv.messages || [];
    const allText = messages.map(m => m.content).join('\n');
    const recentText = messages.slice(-12).map(m => m.content).join('\n');
    const open = detectOpenLoop(messages);
    const refHits = countMatches(allText, REFERENCE_CUES);
    const projectHits = countMatches(allText, PROJECT_CUES);
    const fileSignal = conv.textdocs_count > 0 || conv.attachment_count > 0 || hasAny(allText, FILE_CUES);
    const codeSignal = /```|\b(function|const|let|class|SELECT|CREATE TABLE|python|powershell|pine script)\b/i.test(allText);
    const decisionSignal = /\b(decision|approved|reject|accept|gate|human gate)\b|อนุมัติ|ตัดสินใจ|ยืนยัน|ปฏิเสธ/i.test(allText);
    const turns = messages.length;
    const assistantTurns = messages.filter(m => m.role === 'assistant').length;

    let value = 12 + Math.min(28, turns * 2);
    value += refHits ? 22 + Math.min(10, (refHits - 1) * 8) : 0;
    value += fileSignal ? 16 : 0;
    value += codeSignal ? 12 : 0;
    value += decisionSignal ? 10 : 0;
    value = clamp(value);

    let reuse = 8 + Math.min(20, turns * 1.5) + (refHits ? 28 + Math.min(14, (refHits - 1) * 10) : 0);
    reuse += fileSignal ? 18 : 0;
    reuse += codeSignal ? 18 : 0;
    reuse += decisionSignal ? 12 : 0;
    reuse = clamp(reuse);

    let completion = 55;
    completion += open.assistantResolved ? 30 : 0;
    completion -= open.open ? 38 : 0;
    completion += turns <= 2 && !open.open ? 18 : 0;
    completion += /\b(pass|done|complete|resolved)\b|เสร็จ|เรียบร้อย|จบ/i.test(recentText) ? 12 : 0;
    completion = clamp(completion);

    const pMatch = projectMatch(conv.title, allText, options.projectProfiles);
    const likelyProject = pMatch.score >= 35 && (turns >= 6 || projectHits > 0 || value >= 55);

    let status = 'REFERENCE';
    const reasons = [];
    if (open.open && completion < 82) {
      status = 'CONTINUE';
      reasons.push('Detected an unresolved/open-loop cue in recent turns.');
    } else if (likelyProject) {
      status = 'PROJECT';
      reasons.push(`Strong project match${pMatch.name ? `: ${pMatch.name}` : ''}.`);
    } else if (reuse >= 45 || value >= 58 || fileSignal || codeSignal || decisionSignal) {
      status = 'REFERENCE';
      reasons.push('Contains reusable knowledge, decisions, files, code, or structured work.');
    } else {
      status = 'DELETE_CANDIDATE';
      reasons.push('Looks transactional and has low reusable value after completion.');
    }

    if (status === 'DELETE_CANDIDATE' && (fileSignal || codeSignal || decisionSignal || conv.textdocs_count > 0 || turns >= 7)) {
      status = 'REFERENCE';
      reasons.length = 0;
      reasons.push('Delete guardrail triggered because meaningful evidence or conversation depth exists.');
    }

    if (fileSignal) reasons.push('Attachment/textdoc/file evidence detected.');
    if (codeSignal) reasons.push('Code or technical implementation evidence detected.');
    if (decisionSignal) reasons.push('Decision/approval language detected.');
    if (pMatch.score >= 20) reasons.push(`Project affinity ${pMatch.score}%${pMatch.name ? ` → ${pMatch.name}` : ''}.`);

    const confidence = clamp(45 + Math.abs(value - 50) * 0.35 + Math.abs(completion - 50) * 0.25 + (open.open ? 12 : 0) + (fileSignal ? 8 : 0));
    const nextAction = extractNextAction(messages, open.open);

    return {
      schema_version: SCHEMA_VERSION,
      engine_version: ENGINE_VERSION,
      suggested_status: status,
      confidence,
      scores: { value, completion, reuse, duplicate_risk: 0, project_match: pMatch.score },
      project_suggestion: pMatch.name ? { id: pMatch.id, name: pMatch.name, score: pMatch.score, matched_keywords: pMatch.matched_keywords } : null,
      open_loop: open.open,
      next_action: nextAction,
      reasons: reasons.slice(0, 6),
      signals: { message_count: turns, assistant_turns: assistantTurns, reference_hits: refHits, project_hits: projectHits, file_signal: fileSignal, code_signal: codeSignal, decision_signal: decisionSignal }
    };
  }

  function classifyConversation(input, options = {}) {
    const conv = normalizeConversation(input, options.fallback || {});
    return { conversation: conv, analysis: scoreConversation(conv, options) };
  }

  const api = Object.freeze({
    ENGINE_VERSION,
    SCHEMA_VERSION,
    STATUSES: Object.freeze([...STATUSES]),
    DEFAULT_PROJECTS: Object.freeze(DEFAULT_PROJECTS.map(p => ({ ...p, keywords: [...p.keywords] }))),
    normalizeConversation,
    classifyConversation,
    duplicateRisk,
    titleSimilarity,
    normalizeProjectProfiles
  });

  if (typeof globalThis !== 'undefined') globalThis.ChatStewardEngine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
