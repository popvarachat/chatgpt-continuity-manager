const assert = require('node:assert/strict');
const engine = require('../chat-steward-engine.js');

function classify(messages, extra={}) {
  return engine.classifyConversation({title:'Test Chat', messages, ...extra}).analysis;
}

{
  const a = classify([
    {role:'user', content:'ช่วยแก้ Pine Script ให้ plot Price/Entry'},
    {role:'assistant', content:'ยังมี error 400 ต้องแก้ parser ต่อ'},
    {role:'user', content:'ทำต่อให้จบครับ'}
  ]);
  assert.equal(a.suggested_status, 'CONTINUE');
  assert.equal(a.open_loop, true);
  assert.ok(a.scores.completion < 60);
}

{
  const a = classify([
    {role:'user', content:'สรุป workflow และสูตรทั้งหมดให้เป็น reference'},
    {role:'assistant', content:'สรุปเรียบร้อยแล้ว พร้อม checklist และ policy สำหรับใช้ครั้งต่อไป'}
  ]);
  assert.equal(a.suggested_status, 'REFERENCE');
  assert.ok(a.scores.reuse >= 45);
}

{
  const a = classify([
    {role:'user', content:'1000 บาทเท่ากับกี่ USD'},
    {role:'assistant', content:'ประมาณ 30 USD'}
  ]);
  assert.equal(a.suggested_status, 'DELETE_CANDIDATE');
}

{
  const a = engine.classifyConversation({
    title:'Flood Map Digital Twin',
    messages:[
      {role:'user', content:'ทำ dashboard flood map project'},
      {role:'assistant', content:'เสร็จแล้วสำหรับ phase นี้'},
      {role:'user', content:'สรุป architecture ไว้ด้วย'},
      {role:'assistant', content:'จัดทำ architecture และ workflow เรียบร้อยแล้ว'},
      {role:'user', content:'ขอบคุณ'},
      {role:'assistant', content:'ยินดีครับ'}
    ]
  }).analysis;
  assert.equal(a.suggested_status, 'PROJECT');
  assert.ok(a.project_suggestion);
}

{
  const a = classify([
    {role:'user', content:'ดูไฟล์แนบนี้แล้วสรุป'},
    {role:'assistant', content:'เรียบร้อย'}
  ], {attachments:[{name:'x.pdf'}]});
  assert.notEqual(a.suggested_status, 'DELETE_CANDIDATE');
}

{
  const d = engine.duplicateRisk('TradingView Pine Script Entry Price', [
    {id:'1', title:'TradingView Pine Script Entry Price chart'},
    {id:'2', title:'Trip Shanghai'}
  ]);
  assert.ok(d.score >= 55);
  assert.equal(d.similar_record_id, '1');
}

console.log('chat-steward-engine tests: PASS');
