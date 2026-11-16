const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zkt-json-test-'));
  const env = { ...process.env, PORT: '39871', DEVICE_API_KEY: 'dev-test-secret-123456', DATA_DIR: temp };
  const header = { authorization: 'Bearer ' + env.DEVICE_API_KEY, 'content-type': 'application/json' };
  let proc;
  const boot = async () => {
    proc = spawn(process.execPath, ['server.js'], { cwd: __dirname, env, stdio: 'ignore' });
    for (let i=0;i<80;i++) {
      try { const r = await fetch('http://127.0.0.1:39871/health'); if(r.ok) return; } catch(_){}
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    throw new Error('Server did not boot');
  };
  const req = async (route, method='GET', data) => {
    const res = await fetch('http://127.0.0.1:39871'+route, { method, headers: header, body: data && JSON.stringify(data) });
    return [res.status, await res.json()];
  };
  const cursor = i => i + '.' + 'a'.repeat(80);
  const batch = {device_id:'zkt-001',cursor:null,next_cursor:cursor(2),records:[{user_sn:1,device_user_id:'07230',record_time:'2020-1-8 14:43:10'},{user_sn:2,device_user_id:'07230',record_time:'2020-1-8 14:43:14'}]};
  try {
    await boot();
    assert.deepEqual((await req('/api/attendance/sync-state?device_id=zkt-001'))[1].cursor, null);
    let result = await req('/api/attendance/batches','POST',batch);
    assert.equal(result[0],200); assert.equal(result[1].committed_cursor,cursor(2));
    result = await req('/api/attendance/batches','POST',batch);
    assert.equal(result[0],200);assert.equal(result[1].replay,true);
    result = await req('/api/attendance/sync-state?device_id=zkt-001');
    assert.equal(result[1].total_saved,2);
    result = await req('/api/attendance/records?device_id=zkt-001');
    assert.equal(result[1].records.length,2);
    await new Promise(resolve => {proc.once('exit',resolve); proc.kill();});
    await boot();
    result = await req('/api/attendance/sync-state?device_id=zkt-001');
    assert.equal(result[1].cursor,cursor(2));
    assert.equal(result[1].total_saved,2);
    result = await req('/api/attendance/batches','POST',batch);
    assert.equal(result[1].replay,true);
    const lines = fs.readFileSync(path.join(temp,'attendance.jsonl'),'utf8').trim().split('\n');
    assert.equal(lines.length,1);
    console.log('PASS: first sync, repeat ACK, read records, restart recovery, no duplicate writes');
  } finally { if(proc) proc.kill(); fs.rmSync(temp,{recursive:true,force:true}); }
})().catch(e=>{ console.error(e);process.exitCode=1; });
